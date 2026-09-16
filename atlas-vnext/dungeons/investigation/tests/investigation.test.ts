import { afterEach, describe, expect, it } from 'vitest';
import { InvestigationService } from '../src/index.ts';
import { closePersistence, openDungeonStack } from '../../../tests/helpers/dungeon-stack.ts';
import type { PlatformPersistence } from '@atlas-vnext/persistence';

const persistences: PlatformPersistence[] = [];

afterEach(async () => {
  while (persistences.length) {
    const item = persistences.pop();
    if (item) await closePersistence(item);
  }
});

describe('Investigation dungeon', () => {
  it('builds a caseboard from OSINT finding ids and runs a challenge loop', async () => {
    const stack = await openDungeonStack('The finding does not prove the claim.');
    persistences.push(stack.persistence);
    const finding = await stack.persistence.forActor(stack.actor).dungeonRecords.create(stack.actor, {
      workspaceId: stack.project.id,
      dungeon: 'osint',
      kind: 'finding',
      title: 'username atlas',
      status: 'completed',
      payload: { source: 'pattern.username', confidence: 'possible', summary: 'Username pattern recorded' },
    });
    const investigation = new InvestigationService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      runtime: stack.runtime,
      authority: stack.authority,
    });
    const created = await investigation.createCase(stack.actor, {
      projectId: stack.project.id,
      title: 'Who is atlas?',
      question: 'Does the username finding identify a person?',
      findingIds: [finding.id],
    });
    const challenge = await investigation.challenge(stack.actor, created.id, 'challenger');
    expect(challenge.kind).toBe('challenge');
    expect(challenge.parentId).toBe(created.id);
    expect(challenge.status).toBe('completed');
  });

  it('refuses to import a non-finding record as evidence', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const investigation = new InvestigationService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      runtime: stack.runtime,
      authority: stack.authority,
    });
    const decoy = await stack.persistence.forActor(stack.actor).dungeonRecords.create(stack.actor, {
      workspaceId: stack.project.id,
      dungeon: 'writing',
      kind: 'outline',
      title: 'not a finding',
      status: 'completed',
      payload: {},
    });
    await expect(
      investigation.createCase(stack.actor, {
        projectId: stack.project.id,
        title: 'Bad',
        question: 'q',
        findingIds: [decoy.id],
      }),
    ).rejects.toMatchObject({ code: 'malformed' });
  });
});
