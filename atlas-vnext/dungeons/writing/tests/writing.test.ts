import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeWritingPrompt, writingRouteRequirements, WritingService } from '../src/index.ts';
import { ConversationRuntime, memoryStores } from '@atlas-vnext/conversation';
import { MemoryEventBus } from '@atlas-vnext/events';
import { openMemoryPersistence } from '@atlas-vnext/persistence';
import { ProjectService } from '@atlas-vnext/projects';
import { FilesService } from '@atlas-vnext/files';
import { ContextService } from '@atlas-vnext/context';
import { openFilesystemCas } from '@atlas-vnext/storage';
import { AuthorityEngine } from '@atlas-vnext/permissions';
import type { RouteDecision, StreamChunk } from '@atlas-vnext/contracts';

const dirs: string[] = [];

afterEach(() => {
  dirs.length = 0;
});

function decision(): RouteDecision {
  return {
    target: 'nexus/reason',
    resolvedRouteId: 'mock/mock-reason',
    provider: 'mock',
    model: 'mock-reason',
    candidateChain: ['mock/mock-reason'],
    localOnly: false,
    locality: 'public_cloud',
    runtimeClass: 'always_available',
    decisionReason: 'test',
    traceId: 'trc_test',
    evaluatedAt: '2026-09-14T00:00:00.000Z',
  };
}

async function makeWriting(stream: (prompt: string) => AsyncGenerator<StreamChunk>, capture?: { target?: string; systemPrompt?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'caspa-unit-'));
  dirs.push(dir);
  const persistence = await openMemoryPersistence();
  await persistence.ensureTenant({ id: 'tenant_a', name: 'A' });
  await persistence.ensurePrincipal({ id: 'principal_a', displayName: 'A' });
  const actor = { tenantId: 'tenant_a', principalId: 'principal_a' };
  const cas = await openFilesystemCas(join(dir, 'cas'));
  const files = new FilesService(persistence, cas);
  const projects = new ProjectService(persistence);
  const context = new ContextService(persistence);
  const stores = memoryStores();
  const runtime = new ConversationRuntime({
    conversations: stores.conversations,
    messages: stores.messages,
    executions: stores.executions,
    provenance: stores.provenance,
    events: new MemoryEventBus(),
    router: {
      resolve: (target: string) => {
        if (capture) capture.target = target;
        return decision();
      },
    },
    executor: {
      async *execute(_routed, execContext, observer) {
        if (capture) capture.systemPrompt = execContext.systemPrompt ?? '';
        observer?.onAttempt({
          index: 1,
          provider: 'mock',
          model: 'mock-reason',
          outcome: 'started',
          error: null,
          emittedVisibleOutput: false,
        });
        let visible = false;
        try {
          for await (const chunk of stream(execContext.prompt)) {
            if (chunk.type === 'text') visible = true;
            yield chunk;
          }
          observer?.onAttempt({
            index: 1,
            provider: 'mock',
            model: 'mock-reason',
            outcome: 'succeeded',
            error: null,
            emittedVisibleOutput: visible,
          });
          observer?.onSelected?.({ provider: 'mock', model: 'mock-reason' });
        } catch (err) {
          observer?.onAttempt({
            index: 1,
            provider: 'mock',
            model: 'mock-reason',
            outcome: 'failed',
            error: {
              code: 'provider_error',
              message: err instanceof Error ? err.message : String(err),
              retryable: !visible,
              at: new Date().toISOString(),
            },
            emittedVisibleOutput: visible,
          });
          throw err;
        }
      },
    },
  });
  const authority = new AuthorityEngine();
  authority.grantMembership(actor.principalId, actor.tenantId);
  for (const cap of ['artifact.read', 'artifact.write', 'project.read', 'file.read', 'conversation.write'] as const) {
    authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: cap });
  }
  const writing = new WritingService({ persistence, projects, files, context, runtime, authority });
  const project = await projects.create(actor, { name: 'Book', dungeon: 'writing' });
  return { writing, actor, project, files, persistence, authority };
}

describe('Caspa writing service', () => {
  it('creates, generates, versions, continues, and restores a document', async () => {
    const { writing, actor, project } = await makeWriting(async function* (prompt) {
      yield { type: 'text', text: `Draft from ${prompt.slice(0, 24)}` };
    });
    const created = await writing.create(actor, { projectId: project.id, title: 'Chapter 1', instruction: 'Write a chapter' });
    expect(created.projectId).toBe(project.id);
    expect(created.currentVersion).toBe(0);
    const events = [];
    for await (const event of writing.generate(actor, created.id, {
      operation: 'create',
      instruction: 'Write a chapter about copper kettles.',
      expectedRevision: created.revision,
      fileIds: [],
    })) {
      events.push(event);
    }
    const after = await writing.get(actor, created.id);
    expect(after.status).toBe('committed');
    expect(after.currentVersion).toBe(1);
    expect(after.content).toMatch(/Draft from/);
    const continued = await writing.get(actor, created.id);
    for await (const event of writing.generate(actor, continued.id, {
      operation: 'continue',
      instruction: 'Add a second paragraph.',
      expectedRevision: continued.revision,
    })) {
      events.push(event);
    }
    const v2 = await writing.get(actor, created.id);
    expect(v2.currentVersion).toBe(2);
    const versions = await writing.listVersions(actor, created.id);
    expect(versions.map((item) => item.operation)).toEqual(['create', 'continue']);
    const restored = await writing.restore(actor, created.id, { version: 1, expectedRevision: v2.revision });
    expect(restored.currentVersion).toBe(3);
    expect(restored.content).toBe(after.content);
    const provenance = await writing.provenance(actor, created.id);
    expect(provenance.length).toBeGreaterThan(0);
    expect(provenance.every((entry) => entry.artefactId)).toBe(true);
  });

  it('does not commit a half-streamed failure as the canonical revision', async () => {
    const { writing, actor, project } = await makeWriting(async function* () {
      yield { type: 'text', text: 'Visible draft' };
      throw new Error('provider died after tokens');
    });
    const created = await writing.create(actor, { projectId: project.id, title: 'Fail after' });
    for await (const _event of writing.generate(actor, created.id, {
      operation: 'create',
      instruction: 'Write something.',
      expectedRevision: created.revision,
    })) {
      // drain
    }
    const after = await writing.get(actor, created.id);
    expect(after.status).toBe('failed');
    expect(after.failure?.code).toBe('fail_after_visible');
    expect(after.currentVersion).toBe(0);
    expect(after.content).toBe('');
    expect(after.draft).toMatch(/Visible draft/);
  });

  it('classifies failure before visible output and leaves the document empty', async () => {
    const { writing, actor, project } = await makeWriting(async function* () {
      throw new Error('provider unavailable');
    });
    const created = await writing.create(actor, { projectId: project.id, title: 'Fail before' });
    for await (const _event of writing.generate(actor, created.id, {
      operation: 'create',
      instruction: 'Write something.',
      expectedRevision: created.revision,
    })) {
      // drain
    }
    const after = await writing.get(actor, created.id);
    expect(after.status).toBe('failed');
    expect(after.failure?.code).toBe('fail_before_visible');
    expect(after.currentVersion).toBe(0);
    expect(after.draft).toBeNull();
  });

  it('rejects stale revisions instead of overwriting newer content', async () => {
    const { writing, actor, project } = await makeWriting(async function* () {
      yield { type: 'text', text: 'ok' };
    });
    const created = await writing.create(actor, { projectId: project.id, title: 'Stale' });
    await expect(writing.rename(actor, created.id, { title: 'Nope', expectedRevision: created.revision - 1 })).rejects.toMatchObject({
      code: 'stale_revision',
    });
  });

  it('uses selected files only and refuses missing files', async () => {
    const { writing, actor, project } = await makeWriting(async function* () {
      yield { type: 'text', text: 'grounded' };
    });
    const created = await writing.create(actor, { projectId: project.id, title: 'Grounding' });
    const events = [];
    for await (const event of writing.generate(actor, created.id, {
      operation: 'create',
      instruction: 'Use the brief.',
      expectedRevision: created.revision,
      fileIds: ['file_missing'],
    })) {
      events.push(event);
    }
    expect(events.some((event) => event.type === 'error' && event.failure.code === 'file_missing')).toBe(true);
  });

  it('keeps prompt precedence testable', () => {
    const composed = composeWritingPrompt({
      behaviour: 'standard',
      projectContext: 'notes',
      operation: 'shorten',
      instruction: 'cut',
      currentDocument: 'aaaa',
    });
    expect(composed.precedence[0]).toBe('capabilityPolicy');
    expect(composed.precedence.at(-1)).toBe('requestInstructions');
    expect(writingRouteRequirements({ operation: 'shorten', contentChars: 10, selectedFileCount: 0 }).target).toBe('nexus/fast');
  });

  it('grounds provenance on selected files only and does not dump the project', async () => {
    const capture: { target?: string; systemPrompt?: string } = {};
    const { writing, actor, project, files } = await makeWriting(async function* () {
      yield { type: 'text', text: 'grounded chapter' };
    }, capture);
    const selected = await files.ingest(actor, {
      projectId: project.id,
      path: 'brief.md',
      bytes: new TextEncoder().encode('The copper kettle is canonical.'),
    });
    await files.ingest(actor, {
      projectId: project.id,
      path: 'unused.md',
      bytes: new TextEncoder().encode('secret unused notes'),
    });
    for (let i = 0; i < 16; i += 1) {
      if (!(await files.processNextJob(actor, 'caspa-test'))) break;
    }
    const created = await writing.create(actor, { projectId: project.id, title: 'Grounded' });
    for await (const _event of writing.generate(actor, created.id, {
      operation: 'create',
      instruction: 'Use the brief.',
      expectedRevision: created.revision,
      fileIds: [selected.id],
    })) {
      // drain
    }
    const provenance = await writing.provenance(actor, created.id);
    expect(
      provenance.some((entry) => entry.sourceInputs.includes(selected.id) || entry.sourceInputs.includes(selected.contentHash)),
    ).toBe(true);
    expect(provenance.some((entry) => entry.capability === 'writing')).toBe(true);
    expect(capture.systemPrompt).toContain('The copper kettle is canonical.');
    expect(capture.systemPrompt).not.toContain('secret unused notes');
  });

  it('hides documents from another tenant even with write grants', async () => {
    const { writing, actor, project, persistence, authority } = await makeWriting(async function* () {
      yield { type: 'text', text: 'ok' };
    });
    const created = await writing.create(actor, { projectId: project.id, title: 'Private' });
    await persistence.ensureTenant({ id: 'tenant_b', name: 'B' });
    await persistence.ensurePrincipal({ id: 'principal_b', displayName: 'B' });
    const other = { tenantId: 'tenant_b', principalId: 'principal_b' };
    authority.grantMembership(other.principalId, other.tenantId);
    authority.grantTo({ principalId: other.principalId, tenantId: other.tenantId, capability: 'artifact.write' });
    await expect(writing.get(other, created.id)).rejects.toMatchObject({ message: 'Permission denied.' });
  });

  it('interrupts in-flight documents on restart without promoting the draft', async () => {
    const { writing, actor, project, persistence } = await makeWriting(async function* () {
      yield { type: 'text', text: 'ok' };
    });
    const created = await writing.create(actor, { projectId: project.id, title: 'In flight' });
    await persistence.forActor(actor).documents.update(actor, created.id, {
      status: 'streaming',
      expectedRevision: created.revision,
    });
    await persistence.recoverOnStart();
    const after = await writing.get(actor, created.id);
    expect(after.status).toBe('failed');
    expect(after.failure?.code).toBe('interrupted');
    expect(after.currentVersion).toBe(0);
    expect(after.content).toBe('');
  });

  it('routes through Nexus aliases, never a provider list', async () => {
    const capture: { target?: string } = {};
    const { writing, actor, project } = await makeWriting(async function* () {
      yield { type: 'text', text: 'ok' };
    }, capture);
    const created = await writing.create(actor, { projectId: project.id, title: 'Route' });
    for await (const _event of writing.generate(actor, created.id, {
      operation: 'create',
      instruction: 'Write a long reasoned chapter about copper.',
      expectedRevision: created.revision,
    })) {
      // drain
    }
    expect(capture.target).toBe('nexus/reason');
    expect(capture.target).not.toMatch(/openai|anthropic|runpod/i);
    const after = await writing.get(actor, created.id);
    expect(after.status).toBe('committed');
  });
});
