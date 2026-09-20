import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeWritingPrompt, writingRouteRequirements, WritingService } from '../src/index.ts';
import { ConversationRuntime, memoryStores, type ToolOrchestrator } from '@atlas-vnext/conversation';
import { MemoryEventBus } from '@atlas-vnext/events';
import { openMemoryPersistence, type PlatformPersistence } from '@atlas-vnext/persistence';
import { ProjectService } from '@atlas-vnext/projects';
import { FilesService } from '@atlas-vnext/files';
import { ContextService } from '@atlas-vnext/context';
import { openFilesystemCas } from '@atlas-vnext/storage';
import { AuthorityEngine, EffectivePolicyEngine } from '@atlas-vnext/permissions';
import type { ProvenanceRecord, RouteDecision, StreamChunk } from '@atlas-vnext/contracts';
import type { WritingStreamEvent } from '../src/service.ts';

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

async function makeWriting(
  stream: (prompt: string, signal?: AbortSignal) => AsyncGenerator<StreamChunk>,
  capture?: {
    target?: string;
    systemPrompt?: string;
    tools?: Array<{ id: string }>;
    requireTools?: boolean;
  },
  opts?: { maxGeneratedBytes?: number; toolOrchestrator?: ToolOrchestrator },
) {
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
  if (opts?.toolOrchestrator) {
    const create = stores.conversations.create.bind(stores.conversations);
    stores.conversations.create = async (input) => {
      const conversation = await create(input);
      Object.assign(conversation, { tenantId: actor.tenantId, workspaceId: input.projectId });
      return stores.conversations.save(conversation);
    };
  }
  const runtime = new ConversationRuntime({
    conversations: stores.conversations,
    messages: stores.messages,
    executions: stores.executions,
    provenance: stores.provenance,
    events: new MemoryEventBus(),
    router: {
      resolve: (target: string, request) => {
        if (capture) {
          capture.target = target;
          capture.requireTools = request?.requireTools;
        }
        return decision();
      },
    },
    maxGeneratedBytes: opts?.maxGeneratedBytes,
    toolOrchestrator: opts?.toolOrchestrator,
    principalId: actor.principalId,
    executor: {
      async *execute(_routed, execContext, observer) {
        if (capture) {
          capture.systemPrompt = execContext.systemPrompt ?? '';
          capture.tools = execContext.tools?.map((tool) => ({ id: tool.id }));
        }
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
          for await (const chunk of stream(execContext.prompt, execContext.signal)) {
            if (execContext.signal?.aborted) {
              throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            }
            if (chunk.type === 'text') visible = true;
            yield chunk;
          }
          if (execContext.signal?.aborted) {
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
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
            outcome: execContext.signal?.aborted ? 'cancelled' : 'failed',
            error: {
              code: execContext.signal?.aborted ? 'cancelled' : 'provider_error',
              message: err instanceof Error ? err.message : String(err),
              retryable: !visible && !execContext.signal?.aborted,
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
  const policy = new EffectivePolicyEngine(authority);
  const writing = new WritingService({ persistence, projects, files, context, runtime, authority, policy });
  const project = await projects.create(actor, { name: 'Book', dungeon: 'writing' });
  return { writing, actor, project, files, persistence, authority, policy, runtime, context, projects };
}

async function collect(events: AsyncGenerator<WritingStreamEvent>): Promise<WritingStreamEvent[]> {
  const out: WritingStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function withInjectedWritingProvenanceFailure(persistence: PlatformPersistence): PlatformPersistence {
  return new Proxy(persistence, {
    get(target, prop, receiver) {
      if (prop === 'forActor') {
        return (actor: { tenantId: string; principalId: string }) => {
          const bound = target.forActor(actor);
          return {
            ...bound,
            provenance: {
              ...bound.provenance,
              async record(entry: ProvenanceRecord) {
                if (entry.capability === 'writing') {
                  throw new Error('injected provenance write failure');
                }
                return bound.provenance.record(entry);
              },
            },
          };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe('Caspa writing service', () => {
  it('create is a blank manuscript slot with no evidential provenance until a revision is committed', async () => {
    const { writing, actor, project } = await makeWriting(async function* () {
      yield { type: 'text', text: 'unused' };
    });
    const created = await writing.create(actor, {
      projectId: project.id,
      title: 'Blank chapter',
      instruction: 'Write from imagination',
    });
    expect(created.currentVersion).toBe(0);
    expect(created.content ?? '').toBe('');
    const provenance = await writing.provenance(actor, created.id);
    expect(provenance).toEqual([]);
  });

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

  it('does not advertise or handle tools on generate when tools are not requested', async () => {
    const capture: { tools?: Array<{ id: string }>; requireTools?: boolean } = {};
    const handled: string[] = [];
    const orchestrator: ToolOrchestrator = {
      async listCallable() {
        return [
          { id: 'retrieval.search', description: 'search', inputSchema: { type: 'object' } },
          { id: 'job.run', description: 'enqueue', inputSchema: { type: 'object' } },
          { id: 'project.file_op', description: 'jail file op', inputSchema: { type: 'object' } },
        ];
      },
      async handleCall(input) {
        handled.push(input.call.toolId);
        throw new Error(`handleCall must not run for ${input.call.toolId} on tools-off Caspa generate`);
      },
    };
    const { writing, actor, project } = await makeWriting(
      async function* () {
        yield {
          type: 'tool_call',
          call: { id: 'call_job', toolId: 'job.run', arguments: { label: 'sneak' } },
        };
        yield { type: 'text', text: 'kettle chapter' };
      },
      capture,
      { toolOrchestrator: orchestrator },
    );
    const created = await writing.create(actor, { projectId: project.id, title: 'Tools off' });
    for await (const _event of writing.generate(actor, created.id, {
      operation: 'create',
      instruction: 'Write a chapter.',
      expectedRevision: created.revision,
    })) {
      // drain
    }
    expect(capture.requireTools).toBe(false);
    expect(capture.tools).toBeUndefined();
    expect(handled).toEqual([]);
    const after = await writing.get(actor, created.id);
    expect(after.content).toMatch(/kettle chapter/);
  });

  it('advertises authorised tools on generate when tools are requested', async () => {
    const capture: { tools?: Array<{ id: string }>; requireTools?: boolean } = {};
    const handled: string[] = [];
    const orchestrator: ToolOrchestrator = {
      async listCallable() {
        return [{ id: 'retrieval.search', description: 'search', inputSchema: { type: 'object' } }];
      },
      async handleCall(input) {
        handled.push(input.call.toolId);
        return {
          invocationId: `inv_${input.call.id}`,
          toolId: input.call.toolId,
          status: 'succeeded',
          output: { ok: true },
        };
      },
    };
    const { writing, actor, project } = await makeWriting(
      async function* () {
        yield { type: 'text', text: 'tools-on chapter' };
      },
      capture,
      { toolOrchestrator: orchestrator },
    );
    const created = await writing.create(actor, { projectId: project.id, title: 'Tools on' });
    for await (const _event of writing.generate(actor, created.id, {
      operation: 'create',
      instruction: 'Write a chapter.',
      expectedRevision: created.revision,
      tools: true,
    })) {
      // drain
    }
    expect(capture.requireTools).toBe(true);
    expect(capture.tools).toEqual([{ id: 'retrieval.search' }]);
    expect(handled).toEqual([]);
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

  it('lets only one concurrent same-revision generate succeed', async () => {
    const { writing, actor, project } = await makeWriting(async function* () {
      yield { type: 'text', text: 'Only one winner may commit this document.' };
    });
    const created = await writing.create(actor, { projectId: project.id, title: 'Race' });
    const results = await Promise.all([
      collect(
        writing.generate(actor, created.id, {
          operation: 'create',
          instruction: 'Write first.',
          expectedRevision: created.revision,
        }),
      ),
      collect(
        writing.generate(actor, created.id, {
          operation: 'create',
          instruction: 'Write second.',
          expectedRevision: created.revision,
        }),
      ),
    ]);
    const stale = results.filter((events) =>
      events.some((event) => event.type === 'error' && event.failure.code === 'stale_revision'),
    );
    const committedEvents = results.filter((events) =>
      events.some((event) => event.type === 'document' && event.document.status === 'committed'),
    );
    expect(stale).toHaveLength(1);
    expect(committedEvents).toHaveLength(1);
    const after = await writing.get(actor, created.id);
    expect(after.status).toBe('committed');
    expect(after.currentVersion).toBe(1);
  });

  it('treats cancellation after multiple visible chunks as terminal and keeps the full draft', async () => {
    const { writing, actor, project, runtime } = await makeWriting(async function* (_prompt, signal) {
      yield { type: 'text', text: 'First visible paragraph. ' };
      yield { type: 'text', text: 'Second visible paragraph. ' };
      yield { type: 'text', text: 'Third visible paragraph.' };
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });
    const created = await writing.create(actor, { projectId: project.id, title: 'Cancel after visible' });
    let executionId: string | null = null;
    let deltas = 0;
    const events: WritingStreamEvent[] = [];
    for await (const event of writing.generate(actor, created.id, {
      operation: 'create',
      instruction: 'Write several paragraphs.',
      expectedRevision: created.revision,
    })) {
      events.push(event);
      if (event.type === 'execution' && event.event.type === 'execution') {
        executionId = event.event.execution.id;
      }
      if (event.type === 'draft.delta') {
        deltas += 1;
        if (deltas === 2 && executionId) {
          await runtime.cancel(executionId);
        }
      }
    }
    const after = await writing.get(actor, created.id);
    expect(after.status).toBe('failed');
    expect(after.failure?.code).toBe('cancelled');
    expect(after.currentVersion).toBe(0);
    expect(after.content).toBe('');
    expect(after.draft).toContain('First visible paragraph.');
    expect(after.draft).toContain('Second visible paragraph.');
    expect(events.some((event) => event.type === 'error' && event.failure.code === 'cancelled')).toBe(true);
    expect(events.some((event) => event.type === 'document' && event.document.status === 'committed')).toBe(false);
  });

  it('seals a cancelled draft when the generate iterator is returned after visible output', async () => {
    const { writing, actor, project } = await makeWriting(async function* (_prompt, signal) {
      yield { type: 'text', text: 'Visible draft that must not become a version.' };
      await new Promise<never>(() => {
        void signal;
      });
    });
    const created = await writing.create(actor, { projectId: project.id, title: 'Return after visible' });
    const iterator = writing.generate(actor, created.id, {
      operation: 'create',
      instruction: 'Write a sealed draft.',
      expectedRevision: created.revision,
    })[Symbol.asyncIterator]();
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error('generate ended before visible draft');
      const event = next.value;
      if (event.type === 'draft.delta' && event.text.includes('Visible draft')) {
        await iterator.return?.(undefined);
        break;
      }
    }
    const after = await writing.get(actor, created.id);
    expect(after.status).toBe('failed');
    expect(after.failure?.code).toBe('cancelled');
    expect(after.currentVersion).toBe(0);
    expect(after.content).toBe('');
    expect(after.draft).toContain('Visible draft that must not become a version.');
  });

  it('persists later streamed chunks before a multi-chunk provider failure is sealed', async () => {
    const { writing, actor, project } = await makeWriting(async function* () {
      yield { type: 'text', text: 'First visible chunk. ' };
      yield { type: 'text', text: 'Second visible chunk. ' };
      yield { type: 'text', text: 'Third visible chunk.' };
      throw new Error('provider died after later chunks');
    });
    const created = await writing.create(actor, { projectId: project.id, title: 'Multi-chunk fail' });
    await collect(
      writing.generate(actor, created.id, {
        operation: 'create',
        instruction: 'Write several chunks.',
        expectedRevision: created.revision,
      }),
    );
    const after = await writing.get(actor, created.id);
    expect(after.status).toBe('failed');
    expect(after.failure?.code).toBe('fail_after_visible');
    expect(after.currentVersion).toBe(0);
    expect(after.content).toBe('');
    expect(after.draft).toBe('First visible chunk. Second visible chunk. Third visible chunk.');
  });

  it('persists later streamed chunks before commit:false is sealed', async () => {
    const { writing, actor, project } = await makeWriting(async function* () {
      yield { type: 'text', text: 'First candidate chunk. ' };
      yield { type: 'text', text: 'Second candidate chunk. ' };
      yield { type: 'text', text: 'Third candidate chunk.' };
    });
    const created = await writing.create(actor, { projectId: project.id, title: 'Commit false' });
    await collect(
      writing.generate(actor, created.id, {
        operation: 'create',
        instruction: 'Hold as a candidate.',
        expectedRevision: created.revision,
        commit: false,
      }),
    );
    const after = await writing.get(actor, created.id);
    expect(after.status).toBe('candidate');
    expect(after.currentVersion).toBe(0);
    expect(after.content).toBe('');
    expect(after.draft).toBe('First candidate chunk. Second candidate chunk. Third candidate chunk.');
  });

  it('does not advance canonical content when the writing provenance write fails', async () => {
    const base = await makeWriting(async function* () {
      yield { type: 'text', text: 'Canonical text that must not stick without provenance.' };
    });
    const persistence = withInjectedWritingProvenanceFailure(base.persistence);
    const writing = new WritingService({
      persistence,
      projects: base.projects,
      files: base.files,
      context: base.context,
      runtime: base.runtime,
      authority: base.authority,
      policy: new EffectivePolicyEngine(base.authority),
    });
    const created = await writing.create(base.actor, { projectId: base.project.id, title: 'Provenance fail' });
    const events = await collect(
      writing.generate(base.actor, created.id, {
        operation: 'create',
        instruction: 'Write a chapter.',
        expectedRevision: created.revision,
      }),
    );
    const after = await writing.get(base.actor, created.id);
    expect(after.status).toBe('failed');
    expect(after.currentVersion).toBe(0);
    expect(after.content).toBe('');
    expect(after.draft).toContain('Canonical text that must not stick without provenance.');
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.some((event) => event.type === 'document' && event.document.status === 'committed')).toBe(false);
    const provenance = await writing.provenance(base.actor, created.id);
    expect(provenance.some((entry) => entry.capability === 'writing')).toBe(false);
  });

  it('emits incremental draft.delta text with O(n) payload growth across many tiny chunks', async () => {
    const chunks = Array.from({ length: 400 }, (_, i) => String.fromCharCode(97 + (i % 26)));
    const { writing, actor, project } = await makeWriting(
      async function* () {
        for (const chunk of chunks) yield { type: 'text', text: chunk };
      },
      undefined,
      { maxGeneratedBytes: 512 },
    );
    const created = await writing.create(actor, { projectId: project.id, title: 'Linear draft' });
    const deltas: string[] = [];
    for await (const event of writing.generate(actor, created.id, {
      operation: 'create',
      instruction: 'Write many tiny chunks.',
      expectedRevision: created.revision,
      commit: false,
    })) {
      if (event.type === 'draft.delta') deltas.push(event.text);
    }
    const assembled = chunks.join('');
    expect(deltas).toEqual(chunks);
    expect(deltas.join('')).toBe(assembled);
    const emittedBytes = deltas.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);
    expect(emittedBytes).toBe(Buffer.byteLength(assembled, 'utf8'));
    const quadratic = (assembled.length * (assembled.length + 1)) / 2;
    expect(emittedBytes).toBeLessThan(quadratic / 4);
    const after = await writing.get(actor, created.id);
    expect(after.draft).toBe(assembled);
    expect(after.status).toBe('candidate');
  });

  it('commits an editor revision, stores companions, and commissions through jobs', async () => {
    const { writing, actor, project, persistence } = await makeWriting(async function* () {
      yield { type: 'text', text: 'Commissioned chapter about a copper kettle.' };
    });
    const created = await writing.create(actor, { projectId: project.id, title: 'Chapter' });
    const edited = await writing.edit(actor, created.id, {
      text: 'Hand-edited complete draft.',
      expectedRevision: created.revision,
    });
    expect(edited.content).toBe('Hand-edited complete draft.');
    expect(edited.currentVersion).toBe(1);
    const companion = await writing.saveCompanion(actor, edited.id, {
      kind: 'outline',
      title: 'Outline',
      text: 'I. Kettle\nII. Steam',
    });
    expect(companion.kind).toBe('outline');
    expect(companion.parentId).toBe(edited.id);
    const companions = await writing.listCompanions(actor, edited.id);
    expect(companions).toHaveLength(1);
    const commissioned = await writing.commission(actor, edited.id, {
      operation: 'expand',
      instruction: 'Expand the draft into a short chapter.',
      expectedRevision: edited.revision,
    });
    expect(commissioned.jobId).toMatch(/^job_/);
    const job = await persistence.forActor(actor).jobs.get(actor, commissioned.jobId);
    expect(job?.status).toBe('completed');
    expect(commissioned.document.status).toBe('committed');
    const cancelled = await writing.cancel(actor, commissioned.document.id);
    expect(cancelled.id).toBe(commissioned.document.id);
  });

  it('refuses generate when stored autonomyCeiling is suggest', async () => {
    const { writing, actor, project, persistence, policy } = await makeWriting(async function* () {
      yield { type: 'text', text: 'should not emit' };
    });
    await persistence.forActor(actor).privacy.upsertPolicy(actor, {
      dungeonId: null,
      payload: policy.parse(actor.tenantId, null, { autonomyCeiling: 'suggest' }),
      updatedBy: actor.principalId,
    });
    const created = await writing.create(actor, { projectId: project.id, title: 'Blocked' });
    const events = await collect(
      writing.generate(actor, created.id, {
        operation: 'create',
        instruction: 'Write a chapter.',
        expectedRevision: created.revision,
      }),
    );
    expect(events.some((event) => event.type === 'error' && event.failure.code === 'permission_denied')).toBe(true);
    const after = await writing.get(actor, created.id);
    expect(after.content).toBe('');
    expect(after.currentVersion).toBe(0);
  });

  it('returns a writing result into the requesting conversation and revises the same document', async () => {
    const { writing, actor, project, runtime } = await makeWriting(async function* () {
      yield { type: 'text', text: 'The lighthouse keeper heard a voice from the fog.' };
    });
    const first = await writing.maybeRunFromConversation(actor, {
      conversationId: 'con_ask',
      projectId: project.id,
      question: 'Write a 500-word scene about a lighthouse keeper hearing a voice from the fog.',
    });
    expect(first.handled).toBe(true);
    expect(first.text).toMatch(/^Writing:/);
    expect(first.text).toMatch(/Manuscript:/);
    expect(first.text).not.toMatch(/cas:/);
    const documentId = first.text?.match(/^Document-id:\s*(.+)$/m)?.[1];
    expect(documentId).toBeTruthy();
    const v1 = await writing.get(actor, documentId!);
    expect(v1.currentVersion).toBe(1);
    const second = await writing.maybeRunFromConversation(actor, {
      conversationId: 'con_ask',
      projectId: project.id,
      question: 'Make the final paragraph more restrained.',
    });
    expect(second.handled).toBe(true);
    const v2 = await writing.get(actor, documentId!);
    expect(v2.currentVersion).toBe(2);
    const versions = await writing.listVersions(actor, documentId!);
    expect(versions).toHaveLength(2);
    const runs = await runtime.listConversations();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.title).toBe(`__writing_run__:${documentId}`);
    expect(runs.some((item) => item.id === 'con_ask')).toBe(false);
  });

  it('injects durable story bible facts into later generation', async () => {
    const capture: { systemPrompt?: string } = {};
    const { writing, actor, project } = await makeWriting(async function* () {
      yield { type: 'text', text: 'Chapter two climbed the stair.' };
    }, capture);
    await writing.upsertStoryBible(actor, project.id, {
      characters: [{ name: 'Mara', facts: 'Mara has a scar over her left eye and refuses to enter churches.' }],
      facts: ['Mara has a scar over her left eye and refuses to enter churches.'],
    });
    const created = await writing.create(actor, { projectId: project.id, title: 'Chapter two' });
    for await (const _event of writing.generate(actor, created.id, {
      operation: 'create',
      instruction: 'Write chapter two.',
      expectedRevision: created.revision,
    })) {
      // drain
    }
    expect(capture.systemPrompt).toMatch(/scar over her left eye/);
    expect(capture.systemPrompt).toMatch(/refuses to enter churches/);
  });

  it('blocks unusable output and does not silently veto advisory fog', async () => {
    const blocked = await makeWriting(async function* () {
      yield { type: 'text', text: 'TODO INSERT SOURCE' };
    });
    const created = await blocked.writing.create(blocked.actor, { projectId: blocked.project.id, title: 'Invalid' });
    const events = await collect(
      blocked.writing.generate(blocked.actor, created.id, {
        operation: 'create',
        instruction: 'Write a chapter.',
        expectedRevision: created.revision,
      }),
    );
    expect(events.some((event) => event.type === 'error' && event.failure.code === 'invalid_output')).toBe(true);
    const after = await blocked.writing.get(blocked.actor, created.id);
    expect(after.currentVersion).toBe(0);
    expect(after.status).toBe('failed');
    const quality = await blocked.writing.getQuality(blocked.actor, created.id);
    expect(quality.blocking).toBe(true);

    const capture: { systemPrompt?: string } = {};
    let pass = 0;
    const advisory = await makeWriting(async function* () {
      pass += 1;
      if (pass === 1) yield { type: 'text', text: "In today's fast-paced world the keeper climbed." };
      else yield { type: 'text', text: 'The keeper climbed the cold stair and trimmed the wick.' };
    }, capture);
    const fog = await advisory.writing.create(advisory.actor, { projectId: advisory.project.id, title: 'Fog' });
    for await (const _event of advisory.writing.generate(advisory.actor, fog.id, {
      operation: 'create',
      instruction: 'Write a scene.',
      expectedRevision: fog.revision,
    })) {
      // drain
    }
    const fogged = await advisory.writing.get(advisory.actor, fog.id);
    expect(fogged.currentVersion).toBe(1);
    const fogQuality = await advisory.writing.getQuality(advisory.actor, fog.id);
    expect(fogQuality.state).toBe('advisory');
    for await (const _event of advisory.writing.generate(advisory.actor, fog.id, {
      operation: 'refine',
      instruction: 'Refine this with Caspa Gold.',
      expectedRevision: fogged.revision,
    })) {
      // drain
    }
    expect(capture.systemPrompt).toMatch(/Quality findings to address|AI-fog|fast-paced world/i);
    const refined = await advisory.writing.get(advisory.actor, fog.id);
    expect(refined.currentVersion).toBe(2);
    expect(refined.content).toMatch(/cold stair/);
    expect(refined.content).not.toMatch(/fast-paced world/);
  });

  it('publishes the manuscript to the library with Generated provenance origin', async () => {
    const { writing, actor, project, files } = await makeWriting(async function* () {
      yield { type: 'text', text: 'Harbour lamp against the fog.' };
    });
    const created = await writing.create(actor, { projectId: project.id, title: 'Lighthouse scene' });
    for await (const _event of writing.generate(actor, created.id, {
      operation: 'create',
      instruction: 'Write a short scene.',
      expectedRevision: created.revision,
    })) {
      // drain
    }
    const listed = await files.list(actor, project.id);
    const manuscript = listed.find((file) => file.displayName === 'Lighthouse scene');
    expect(manuscript).toBeTruthy();
    expect(manuscript?.path).toMatch(/^manuscripts\/doc_/);
    const origin = await files.originFor(actor, manuscript!);
    expect(origin).toBe('generated');
  });

  it('does not treat ordinary questions as writing', async () => {
    const { writing, actor, project } = await makeWriting(async function* () {
      yield { type: 'text', text: 'should not run' };
    });
    expect(
      await writing.maybeRunFromConversation(actor, {
        conversationId: 'con_ask',
        projectId: project.id,
        question: 'What is a lighthouse keeper?',
      }),
    ).toEqual({ handled: false });
    expect(
      await writing.maybeRunFromConversation(actor, {
        conversationId: 'con_ask',
        projectId: project.id,
        question: 'Which of those findings is strongest?',
      }),
    ).toEqual({ handled: false });
  });

  it('cancels the nested writing run when the conversation signal aborts', async () => {
    const { writing, actor, project } = await makeWriting(async function* (_prompt, signal) {
      yield { type: 'text', text: 'Visible draft that must not become a version. ' };
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });
    const controller = new AbortController();
    const pending = writing.maybeRunFromConversation(actor, {
      conversationId: 'con_ask',
      projectId: project.id,
      question: 'Write a 500-word scene about a lighthouse keeper hearing a voice from the fog.',
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    controller.abort();
    const result = await pending;
    expect(result.handled).toBe(true);
    expect(result.failed).toBe(true);
    expect(result.text).toMatch(/cancelled/i);
    const docs = await writing.list(actor, project.id);
    expect(docs.some((item) => item.status === 'committed')).toBe(false);
  });

  it('keeps a committed revision if library publish fails', async () => {
    const { writing, actor, project, files } = await makeWriting(async function* () {
      yield { type: 'text', text: 'The harbour lamp stayed lit through the storm.' };
    });
    const original = files.publishArtefactFile.bind(files);
    files.publishArtefactFile = async () => {
      throw new Error('library index unavailable');
    };
    try {
      const created = await writing.create(actor, { projectId: project.id, title: 'Harbour' });
      await collect(
        writing.generate(actor, created.id, {
          operation: 'create',
          instruction: 'Write the harbour scene.',
          expectedRevision: created.revision,
        }),
      );
      const after = await writing.get(actor, created.id);
      expect(after.status).toBe('committed');
      expect(after.currentVersion).toBe(1);
      expect(after.content).toMatch(/harbour lamp/);
    } finally {
      files.publishArtefactFile = original;
    }
  });

  it('stores conversation canon without a manuscript document id', async () => {
    const { writing, actor, project } = await makeWriting(async function* () {
      yield { type: 'text', text: 'unused' };
    });
    const result = await writing.maybeRunFromConversation(actor, {
      conversationId: 'con_ask',
      projectId: project.id,
      question: 'Remember for this story that Mara will not enter churches.',
    });
    expect(result.handled).toBe(true);
    expect(result.text).toMatch(/Story bible/);
    expect(result.text).not.toMatch(/Document-id:/);
  });

  it('replaces editor-saved canon lines instead of appending them', async () => {
    const { writing, actor, project } = await makeWriting(async function* () {
      yield { type: 'text', text: 'unused' };
    });
    await writing.upsertStoryBible(actor, project.id, { facts: ['Mara hates churches.', 'Wrong fact.'] });
    await writing.upsertStoryBible(actor, project.id, { facts: ['Mara will not enter churches.'] }, { replace: true });
    const bible = await writing.getStoryBible(actor, project.id);
    expect(bible.facts).toEqual(['Mara will not enter churches.']);
    expect(bible.facts).not.toContain('Wrong fact.');
  });
});
