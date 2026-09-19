import { afterEach, describe, expect, it } from 'vitest';
import { ResearchService } from '../src/index.ts';
import { closePersistence, openDungeonStack, storeTenantPolicy } from '../../../tests/helpers/dungeon-stack.ts';
import type { PlatformPersistence } from '@atlas-vnext/persistence';

const persistences: PlatformPersistence[] = [];

afterEach(async () => {
  while (persistences.length) {
    const item = persistences.pop();
    if (item) await closePersistence(item);
  }
});

describe('Research dungeon', () => {
  it('retrieves selected files and synthesises with backend citations', async () => {
    const stack = await openDungeonStack('The notes describe a copper kettle. Source: notes.md.');
    persistences.push(stack.persistence);
    const file = await stack.files.ingest(stack.actor, {
      projectId: stack.project.id,
      path: 'notes.md',
      bytes: new TextEncoder().encode('A copper kettle sings on the stove.'),
    });
    for (let i = 0; i < 16; i += 1) {
      if (!(await stack.files.processNextJob(stack.actor, 'research-test'))) break;
    }
    const research = new ResearchService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      context: stack.context,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
    });
    const brief = await research.create(stack.actor, {
      projectId: stack.project.id,
      question: 'What object is on the stove?',
      fileIds: [file.id],
    });
    const result = await research.run(stack.actor, brief.id);
    expect(result.synthesis.kind).toBe('synthesis');
    expect(result.context.slices.length).toBeGreaterThan(0);
    expect(result.synthesis.payload.citations).toBeDefined();
    expect(result.waves.length).toBeGreaterThan(0);
    expect(result.synthesis.payload.webSearch).toBe('unavailable');
  });

  it('runs a second search wave when the first coverage is inadequate', async () => {
    const stack = await openDungeonStack('Kettle notes.');
    persistences.push(stack.persistence);
    let calls = 0;
    const research = new ResearchService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      context: stack.context,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
      search: {
        async search({ queries }) {
          calls += 1;
          const retrievedAt = new Date().toISOString();
          if (calls === 1) {
            return {
              queries,
              mode: 'research' as const,
              engines: ['fixture'],
              hits: [],
              coverage: { score: 0, engineCount: 0, hitCount: 0, primaryLike: 0, gaps: ['no_hits'] },
              retrievedAt,
            };
          }
          return {
            queries,
            mode: 'research' as const,
            engines: ['wikipedia', 'duckduckgo'],
            hits: [
              {
                rank: 1,
                title: 'Copper kettle',
                url: 'https://en.wikipedia.org/wiki/Kettle',
                canonicalUrl: 'https://en.wikipedia.org/wiki/Kettle',
                snippet: 'A kettle is a vessel for boiling water.',
                engine: 'wikipedia',
                sourceType: 'encyclopedia' as const,
                engineCount: 1,
                engines: ['wikipedia'],
                retrievedAt,
              },
            ],
            coverage: { score: 40, engineCount: 2, hitCount: 1, primaryLike: 1, gaps: [] },
            retrievedAt,
          };
        },
        async inspect({ url }) {
          return {
            url,
            canonicalUrl: url,
            title: 'Kettle',
            excerpt: 'Inspected kettle article.',
            status: 200,
            retrievedAt: new Date().toISOString(),
          };
        },
      },
    });
    const conversation = await stack.runtime.createConversation({ title: 'Ask', projectId: stack.project.id });
    const brief = await research.create(stack.actor, {
      projectId: stack.project.id,
      question: 'What is a copper kettle?',
      conversationId: conversation.id,
    });
    const result = await research.run(stack.actor, brief.id, { conversationId: conversation.id });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.waves.length).toBeGreaterThanOrEqual(2);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.synthesis.payload.webSearch).toBe('used');
    const snapshot = await stack.runtime.getSnapshot(conversation.id);
    expect(snapshot?.messages.some((message) => message.role === 'assistant' && message.content.includes('Strongest finding'))).toBe(
      true,
    );
  });

  it('does not retrieve files when stored retrievalScope is none', async () => {
    const stack = await openDungeonStack('Should not appear in synthesis context.');
    persistences.push(stack.persistence);
    const file = await stack.files.ingest(stack.actor, {
      projectId: stack.project.id,
      path: 'secret.md',
      bytes: new TextEncoder().encode('classified kettle notes'),
    });
    for (let i = 0; i < 16; i += 1) {
      if (!(await stack.files.processNextJob(stack.actor, 'research-none'))) break;
    }
    await storeTenantPolicy(stack, { retrievalScope: 'none' });
    const research = new ResearchService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      context: stack.context,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
    });
    const brief = await research.create(stack.actor, {
      projectId: stack.project.id,
      question: 'What is classified?',
      fileIds: [file.id],
    });
    const result = await research.run(stack.actor, brief.id);
    expect(result.context.slices).toEqual([]);
  });

  it('refuses run when stored autonomyCeiling is suggest', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    await storeTenantPolicy(stack, { autonomyCeiling: 'suggest' });
    const research = new ResearchService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      context: stack.context,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
    });
    const brief = await research.create(stack.actor, {
      projectId: stack.project.id,
      question: 'Should not run',
    });
    await expect(research.run(stack.actor, brief.id)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('does not post research notices onto another project conversation', async () => {
    const stack = await openDungeonStack('Kettle notes.');
    persistences.push(stack.persistence);
    const other = await stack.projects.create(stack.actor, { name: 'Other', dungeon: 'research' });
    const foreign = await stack.runtime.createConversation({ title: 'Other thread', projectId: other.id });
    const research = new ResearchService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      context: stack.context,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
    });
    const brief = await research.create(stack.actor, {
      projectId: stack.project.id,
      question: 'What is on the stove?',
      conversationId: foreign.id,
    });
    await research.run(stack.actor, brief.id, { conversationId: foreign.id });
    const snapshot = await stack.runtime.getSnapshot(foreign.id);
    expect(snapshot?.messages ?? []).toEqual([]);
  });
});
