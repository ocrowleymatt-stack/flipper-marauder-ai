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
  it('does not mark a text packet as completed without audio bytes', async () => {
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
    expect(composed.status).not.toBe('completed');
    expect(composed.payload.audioArtefactId).toBeNull();
    const text = await stack.files.readArtefactText(stack.actor, String(composed.payload.packetArtefactId));
    expect(text).not.toMatch(/runpod/i);
  });

  it('completes only after a playable audio artefact is stored', async () => {
    const stack = await openDungeonStack('Tempo 92.');
    persistences.push(stack.persistence);
    const wav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00,
      0x00, 0x01, 0x00, 0x02, 0x00, 0x22, 0x56, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00, 0x04, 0x00, 0x10, 0x00, 0x64, 0x61,
      0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
    ]);
    const conversation = await stack.runtime.createConversation({ title: 'Ask', projectId: stack.project.id });
    const music = new MusicService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      runtime: stack.runtime,
      authority: stack.authority,
      policy: stack.policy,
      audio: {
        async render() {
          return {
            status: 'rendered',
            bytes: wav,
            mimeType: 'audio/wav',
            renderer: 'test-audition',
            durationMs: 1000,
            detail: 'Test fixture audio.',
          };
        },
      },
    });
    const created = await music.create(stack.actor, {
      projectId: stack.project.id,
      title: 'Copper',
      brief: 'A restrained theme.',
      conversationId: conversation.id,
    });
    const composed = await music.compose(stack.actor, created.id, { conversationId: conversation.id });
    expect(composed.status).toBe('completed');
    expect(composed.payload.audioArtefactId).toBeTruthy();
    const packed = await stack.files.readArtefactBytes(stack.actor, String(composed.payload.audioArtefactId));
    expect(packed.mimeType).toBe('audio/wav');
    expect(packed.bytes.byteLength).toBeGreaterThan(12);
    const snapshot = await stack.runtime.getSnapshot(conversation.id);
    expect(snapshot?.messages.some((message) => message.content.includes('atlas:media'))).toBe(true);
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
