import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConversationRuntime, memoryStores } from '@atlas-vnext/conversation';
import { MemoryEventBus } from '@atlas-vnext/events';
import { openMemoryPersistence } from '@atlas-vnext/persistence';
import { ProjectService } from '@atlas-vnext/projects';
import { FilesService } from '@atlas-vnext/files';
import { ContextService } from '@atlas-vnext/context';
import { openFilesystemCas } from '@atlas-vnext/storage';
import { AuthorityEngine, EffectivePolicyEngine } from '@atlas-vnext/permissions';
import type { RouteDecision, StreamChunk } from '@atlas-vnext/contracts';
import { WritingService } from '../src/index.ts';
import { assembleNovelContext, isFindingsOnlyOperation, parseFindings, parseStoryBible } from '../src/novel.ts';
import type { WritingStreamEvent } from '../src/service.ts';

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

async function makeWriting(stream: (prompt: string) => AsyncGenerator<StreamChunk>) {
  const dir = mkdtempSync(join(tmpdir(), 'caspa-novel-'));
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
    router: { resolve: () => decision() },
    principalId: actor.principalId,
    executor: {
      async *execute(_routed, execContext, observer) {
        observer?.onAttempt({
          index: 1,
          provider: 'mock',
          model: 'mock-reason',
          outcome: 'started',
          error: null,
          emittedVisibleOutput: false,
        });
        let visible = false;
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
      },
    },
  });
  const authority = new AuthorityEngine();
  authority.grantMembership(actor.principalId, actor.tenantId);
  for (const cap of ['artifact.read', 'artifact.write', 'project.read', 'file.read', 'conversation.write'] as const) {
    authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: cap });
  }
  const writing = new WritingService({
    persistence,
    projects,
    files,
    context,
    runtime,
    authority,
    policy: new EffectivePolicyEngine(authority),
  });
  const project = await projects.create(actor, { name: 'Harbour', dungeon: 'writing' });
  return { writing, actor, project, persistence };
}

async function collect(events: AsyncGenerator<WritingStreamEvent>) {
  const out: WritingStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('Caspa novel machine substrate', () => {
  it('distinguishes findings-only operations from manuscript mutations', () => {
    expect(isFindingsOnlyOperation('critique')).toBe(true);
    expect(isFindingsOnlyOperation('continuity_check')).toBe(true);
    expect(isFindingsOnlyOperation('draft_scene')).toBe(false);
    expect(isFindingsOnlyOperation('edit')).toBe(false);
  });

  it('assembles bounded novel context without dumping the whole manuscript', () => {
    const assembled = assembleNovelContext({
      operation: 'continue_scene',
      instruction: 'Continue Mara at the harbour',
      currentDocument: 'Mara waited on the quay.',
      documentId: 'doc_1',
      bible: {
        id: 'bible_1',
        title: 'Bible',
        payload: { premise: 'A smuggler returns home', genre: 'literary', tone: 'restrained' },
        contentHash: 'hash_bible',
      },
      characters: [
        { id: 'c1', title: 'Mara', payload: { name: 'Mara', voice: 'short sentences' }, contentHash: 'h1' },
        { id: 'c2', title: 'Unmentioned', payload: { name: 'Gideon Hale the Quiet' }, contentHash: 'h2' },
      ],
      fileIds: ['fil_1'],
    });
    expect(assembled.text).toContain('Story bible');
    expect(assembled.text).toContain('Mara');
    expect(assembled.text).not.toContain('Gideon Hale the Quiet');
    expect(assembled.manifest.refs.some((ref) => ref.kind === 'story_bible')).toBe(true);
    expect(assembled.manifest.refs.some((ref) => ref.title === 'Mara')).toBe(true);
    expect(assembled.manifest.fileIds).toEqual(['fil_1']);
  });

  it('parses critique findings without inventing numeric scores', () => {
    const findings = parseFindings(`## Pacing stall
Location: paragraph 2
The harbour description repeats itself.

## Character consistency
Quote: “Mara never flinches.”
She flinched two pages ago.`);
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings.some((item) => /pacing/i.test(item.concern))).toBe(true);
    expect(JSON.stringify(findings)).not.toMatch(/\b(9\d|100)\/100\b/);
  });

  it('persists story bible, characters, and structure on the project', async () => {
    const { writing, actor, project } = await makeWriting(async function* () {
      yield { type: 'text', text: 'unused' };
    });
    const bible = await writing.saveStoryBible(actor, project.id, {
      payload: { premise: 'A copper kettle sings', genre: 'fable', tone: 'warm' },
    });
    expect(bible.kind).toBe('story_bible');
    expect(parseStoryBible(bible.payload).premise).toContain('copper kettle');
    const character = await writing.saveCharacter(actor, project.id, {
      payload: { name: 'Mara', role: 'smuggler', voice: 'clipped' },
    });
    expect(character.kind).toBe('character');
    const structure = await writing.saveStructure(actor, project.id, {
      payload: { chapters: [{ id: 'ch_1', title: 'Harbour', documentId: null, summary: '', scenes: [] }] },
    });
    expect(structure.kind).toBe('structure');
    expect((await writing.listCharacters(actor, project.id)).some((row) => row.title === 'Mara')).toBe(true);
    expect((await writing.getStoryBible(actor, project.id))?.id).toBe(bible.id);
  });

  it('records creative lineage on generate and does not treat it as evidential provenance', async () => {
    const { writing, actor, project } = await makeWriting(async function* () {
      yield { type: 'text', text: 'The kettle sang over the harbour stones.' };
    });
    await writing.saveStoryBible(actor, project.id, { payload: { premise: 'A singing kettle', genre: 'fable' } });
    const created = await writing.create(actor, { projectId: project.id, title: 'Harbour' });
    await collect(
      writing.generate(actor, created.id, {
        operation: 'draft_scene',
        instruction: 'Draft the harbour opening.',
        expectedRevision: created.revision,
      }),
    );
    const reloaded = await writing.get(actor, created.id);
    expect(reloaded.status).toBe('committed');
    expect(reloaded.currentVersion).toBe(1);
    const lineage = await writing.listLineage(actor, created.id);
    expect(lineage.some((row) => row.kind === 'creative_lineage')).toBe(true);
    expect(lineage[0]?.payload).toMatchObject({ operation: 'draft_scene', documentId: created.id });
    const provenance = await writing.provenance(actor, created.id);
    expect(provenance.length).toBeGreaterThan(0);
    expect(lineage[0]?.id).not.toBe(provenance[0]?.artefactId);
  });

  it('critique records findings without overwriting manuscript content', async () => {
    const { writing, actor, project } = await makeWriting(async function* (prompt) {
      if (prompt.includes('Do NOT rewrite')) {
        yield { type: 'text', text: '## Tension\nLocation: last line\nThe scene ends before the choice lands.' };
        return;
      }
      yield { type: 'text', text: 'Mara kept the kettle between them.' };
    });
    const created = await writing.create(actor, { projectId: project.id, title: 'Harbour' });
    const first = await writing.get(actor, created.id);
    await collect(
      writing.generate(actor, first.id, {
        operation: 'draft_scene',
        instruction: 'Write the scene.',
        expectedRevision: first.revision,
      }),
    );
    const drafted = await writing.get(actor, created.id);
    const manuscript = drafted.content;
    expect(manuscript.length).toBeGreaterThan(0);
    await collect(
      writing.generate(actor, drafted.id, {
        operation: 'critique',
        instruction: 'Critique the scene.',
        expectedRevision: drafted.revision,
      }),
    );
    const after = await writing.get(actor, created.id);
    expect(after.content).toBe(manuscript);
    expect(after.currentVersion).toBe(drafted.currentVersion);
    const findings = await writing.listContinuity(actor, project.id);
    expect(findings.some((row) => row.kind === 'critique')).toBe(true);
  });

  it('stale-revision still rejects concurrent manuscript writes', async () => {
    const { writing, actor, project } = await makeWriting(async function* () {
      yield { type: 'text', text: 'first' };
    });
    const created = await writing.create(actor, { projectId: project.id, title: 'Harbour' });
    await collect(
      writing.generate(actor, created.id, {
        operation: 'draft_scene',
        instruction: 'Draft.',
        expectedRevision: created.revision,
      }),
    );
    const latest = await writing.get(actor, created.id);
    await expect(
      writing.edit(actor, latest.id, { text: 'stale overwrite', expectedRevision: created.revision }),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    const restored = await writing.restore(actor, latest.id, { version: 1, expectedRevision: latest.revision });
    expect(restored.currentVersion).toBeGreaterThan(latest.currentVersion);
  });

  it('isolates novel records across tenants', async () => {
    const { writing, actor, project, persistence } = await makeWriting(async function* () {
      yield { type: 'text', text: 'x' };
    });
    await writing.saveStoryBible(actor, project.id, { payload: { premise: 'secret' } });
    await persistence.ensureTenant({ id: 'tenant_b', name: 'B' });
    await persistence.ensurePrincipal({ id: 'principal_b', displayName: 'B' });
    const other = { tenantId: 'tenant_b', principalId: 'principal_b' };
    await expect(writing.getStoryBible(other, project.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('keeps outline companions distinct from creative lineage after a revision', async () => {
    const { writing, actor, project } = await makeWriting(async function* () {
      yield { type: 'text', text: 'The kettle sang.' };
    });
    const created = await writing.create(actor, { projectId: project.id, title: 'Harbour' });
    await collect(
      writing.generate(actor, created.id, {
        operation: 'draft_scene',
        instruction: 'Draft.',
        expectedRevision: created.revision,
      }),
    );
    const drafted = await writing.get(actor, created.id);
    await writing.saveCompanion(actor, drafted.id, { kind: 'outline', title: 'Outline', text: 'Mara arrives.' });
    const companions = await writing.listCompanions(actor, drafted.id);
    expect(companions.every((row) => row.kind === 'outline')).toBe(true);
    expect(companions).toHaveLength(1);
    const lineage = await writing.listLineage(actor, drafted.id);
    expect(lineage.length).toBeGreaterThan(0);
    expect(companions.some((row) => row.kind === 'creative_lineage')).toBe(false);
  });
});
