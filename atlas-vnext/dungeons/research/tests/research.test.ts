import { afterEach, describe, expect, it } from 'vitest';
import { ResearchService } from '../src/index.ts';
import { closePersistence, openDungeonStack } from '../../../tests/helpers/dungeon-stack.ts';
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
  });
});
