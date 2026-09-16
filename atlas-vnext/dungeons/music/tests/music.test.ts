import { afterEach, describe, expect, it } from 'vitest';
import { MusicService } from '../src/index.ts';
import { closePersistence, openDungeonStack, storeTenantPolicy } from '../../../tests/helpers/dungeon-stack.ts';
import type { PlatformPersistence } from '@atlas-vnext/persistence';

const persistences: PlatformPersistence[] = [];

afterEach(async () => {
  while (persistences.length) {
    const item = persistences.pop();
    if (item) await closePersistence(item);
  }
});

describe('Music dungeon', () => {
  it('stores a composition packet without naming GPU vendors', async () => {
    const stack = await openDungeonStack('Tempo 92. Verse chorus verse. Lyrics remain local.');
    persistences.push(stack.persistence);
    const music = new MusicService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
    });
    const created = await music.create(stack.actor, {
      projectId: stack.project.id,
      title: 'Copper',
      brief: 'A restrained theme.',
    });
    const composed = await music.compose(stack.actor, created.id);
    expect(composed.status).toBe('completed');
    expect(composed.artefactId).toBeTruthy();
    const text = await stack.files.readArtefactText(stack.actor, composed.artefactId!);
    expect(text).not.toMatch(/runpod/i);
  });

  it('refuses compose when stored autonomyCeiling is suggest', async () => {
    const stack = await openDungeonStack('should not compose');
    persistences.push(stack.persistence);
    await storeTenantPolicy(stack, { autonomyCeiling: 'suggest' });
    const music = new MusicService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
    });
    const created = await music.create(stack.actor, {
      projectId: stack.project.id,
      title: 'Blocked',
      brief: 'A theme.',
    });
    await expect(music.compose(stack.actor, created.id)).rejects.toMatchObject({ httpStatus: 404 });
  });
});
