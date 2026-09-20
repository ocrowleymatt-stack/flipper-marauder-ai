import { afterEach, describe, expect, it } from 'vitest';
import type { MusicScore, MusicScorePort } from '@atlas-vnext/contracts';
import type { PlatformPersistence } from '@atlas-vnext/persistence';
import { MusicService } from '../src/index.ts';
import { isMidiBytes } from '../src/midi.ts';
import { parseMusicScore } from '../src/score.ts';
import { isWavBytes, wavPeakAbs } from '../src/wav.ts';
import { closePersistence, openDungeonStack, storeTenantPolicy } from '../../../tests/helpers/dungeon-stack.ts';

const persistences: PlatformPersistence[] = [];

afterEach(async () => {
  while (persistences.length) {
    const item = persistences.pop();
    if (item) await closePersistence(item);
  }
});

function fixtureScore(title = 'Rain', tempoBpm = 90): MusicScore {
  return parseMusicScore({
    title,
    tempoBpm,
    timeSignature: [4, 4],
    key: 'A minor',
    tracks: [
      {
        name: 'Piano',
        channel: 0,
        program: 0,
        notes: [
          { pitch: 57, startBeat: 0, durationBeats: 1, velocity: 90 },
          { pitch: 60, startBeat: 1, durationBeats: 1, velocity: 80 },
          { pitch: 64, startBeat: 2, durationBeats: 2, velocity: 86 },
          { pitch: 69, startBeat: 4, durationBeats: 2, velocity: 78 },
        ],
      },
    ],
  });
}

function port(score: MusicScore = fixtureScore()): MusicScorePort {
  return {
    async generateScore() {
      return { score };
    },
  };
}

describe('Music dungeon', () => {
  it('stores score-first MIDI and WAV, publishes Library files, and revises the same composition', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const music = new MusicService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      authority: stack.authority,
      policy: stack.policy,
      generate: port(),
    });
    const first = await music.maybeRunFromConversation(stack.actor, {
      conversationId: 'con_music',
      projectId: stack.project.id,
      question: 'Compose a 30-second piano piece in A minor, 90 BPM.',
    });
    expect(first.handled).toBe(true);
    expect(first.text).toMatch(/^Music:/);
    expect(first.text).not.toMatch(/runpod|ace-step|provider/i);
    const compositionId = first.text?.match(/^Composition:\s+(cmp_\S+)/m)?.[1];
    expect(compositionId).toBeTruthy();
    const files = await stack.files.list(stack.actor, stack.project.id);
    expect(files.some((file) => file.path === `compositions/${compositionId}/audition.wav`)).toBe(true);
    expect(files.some((file) => file.path === `compositions/${compositionId}/composition.mid`)).toBe(true);
    const wavFile = files.find((file) => file.path.endsWith('audition.wav'))!;
    expect(await stack.files.originFor(stack.actor, wavFile)).toBe('generated');
    const wav = await stack.files.readBytes(stack.actor, wavFile.id);
    expect(isWavBytes(wav)).toBe(true);
    expect(wavPeakAbs(wav)).toBeGreaterThan(0.05);
    const midiFile = files.find((file) => file.path.endsWith('composition.mid'))!;
    expect(isMidiBytes(await stack.files.readBytes(stack.actor, midiFile.id))).toBe(true);

    const slower = await music.maybeRunFromConversation(stack.actor, {
      conversationId: 'con_music',
      projectId: stack.project.id,
      question: 'Make it slower.',
    });
    expect(slower.text).toMatch(/Revision: 2/);
    expect(slower.text).toContain(compositionId);
    const updated = await music.get(stack.actor, compositionId!);
    expect(Number(updated.payload.tempoBpm)).toBeLessThan(90);

    const other = await music.create(stack.actor, { projectId: stack.project.id, title: 'Other', brief: 'other' });
    await music.compose(stack.actor, other.id, { conversationId: 'con_other', brief: 'other' });
    const regenerated = await music.maybeRunFromConversation(stack.actor, {
      conversationId: 'con_music',
      projectId: stack.project.id,
      question: 'Regenerate this version.',
    });
    expect(regenerated.text).toContain(compositionId);
    expect(regenerated.text).not.toContain(other.id);
  });

  it('cancels before commit and does not fabricate success or WAV', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const controller = new AbortController();
    const generate: MusicScorePort = {
      async generateScore(input) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 30_000);
          input.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            const error = new Error('aborted') as Error & { code: string };
            error.code = 'aborted';
            reject(error);
          });
        });
        return { score: fixtureScore('Should not commit') };
      },
    };
    const music = new MusicService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      authority: stack.authority,
      policy: stack.policy,
      generate,
    });
    const pending = music.maybeRunFromConversation(stack.actor, {
      conversationId: 'con_cancel',
      projectId: stack.project.id,
      question: 'Compose a song about cancelled fireworks.',
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    expect(result.handled).toBe(true);
    expect(result.failed).toBe(true);
    expect(result.text).toMatch(/cancelled/i);
    const rows = await music.list(stack.actor, stack.project.id);
    expect(rows.every((row) => row.status !== 'completed')).toBe(true);
    const files = await stack.files.list(stack.actor, stack.project.id);
    expect(files.some((file) => file.path.includes('audition.wav'))).toBe(false);
  });

  it('keeps a committed composition when later Library publication fails', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const original = stack.files.publishArtefactFile.bind(stack.files);
    stack.files.publishArtefactFile = async () => {
      throw new Error('library unavailable');
    };
    try {
      const music = new MusicService({
        persistence: stack.persistence,
        projects: stack.projects,
        files: stack.files,
        authority: stack.authority,
        policy: stack.policy,
        generate: port(),
      });
      const created = await music.create(stack.actor, { projectId: stack.project.id, title: 'Keep', brief: 'keep' });
      const generated = await music.compose(stack.actor, created.id, { brief: 'keep' });
      expect(generated.libraryOk).toBe(false);
      expect(generated.reportText).toMatch(/playable/i);
      expect((await music.get(stack.actor, created.id)).status).toBe('completed');
      expect(isWavBytes(generated.wav)).toBe(true);
    } finally {
      stack.files.publishArtefactFile = original;
    }
  });

  it('fails closed on invalid score and does not fabricate WAV', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    const generate: MusicScorePort = {
      async generateScore() {
        const error = new Error('invalid') as Error & { code: string };
        error.code = 'invalid_score';
        throw error;
      },
    };
    const music = new MusicService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      authority: stack.authority,
      policy: stack.policy,
      generate,
    });
    const result = await music.maybeRunFromConversation(stack.actor, {
      conversationId: 'con_bad',
      projectId: stack.project.id,
      question: 'Compose a song about unparseable weather.',
    });
    expect(result.failed).toBe(true);
    const files = await stack.files.list(stack.actor, stack.project.id);
    expect(files.some((file) => file.path.endsWith('.wav'))).toBe(false);
  });

  it('refuses compose when stored autonomyCeiling is suggest', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    await storeTenantPolicy(stack, { autonomyCeiling: 'suggest' });
    const music = new MusicService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      authority: stack.authority,
      policy: stack.policy,
      generate: port(),
    });
    const created = await music.create(stack.actor, { projectId: stack.project.id, title: 'Blocked', brief: 'A theme.' });
    await expect(music.compose(stack.actor, created.id, { brief: 'A theme.' })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('fails closed across tenants and for read-only principals', async () => {
    const stack = await openDungeonStack();
    persistences.push(stack.persistence);
    await stack.persistence.ensureTenant({ id: 'tenant_b', name: 'B' });
    await stack.persistence.ensurePrincipal({ id: 'principal_b', displayName: 'B' });
    const other = { tenantId: 'tenant_b', principalId: 'principal_b' };
    stack.authority.grantMembership(other.principalId, other.tenantId);
    stack.authority.grantTo({ principalId: other.principalId, tenantId: other.tenantId, capability: 'artifact.read' });
    stack.authority.grantTo({ principalId: other.principalId, tenantId: other.tenantId, capability: 'artifact.write' });
    const reader = { tenantId: 'tenant_a', principalId: 'principal_reader' };
    stack.authority.grantMembership(reader.principalId, reader.tenantId);
    stack.authority.grantTo({ principalId: reader.principalId, tenantId: reader.tenantId, capability: 'artifact.read' });
    const music = new MusicService({
      persistence: stack.persistence,
      projects: stack.projects,
      files: stack.files,
      authority: stack.authority,
      policy: stack.policy,
      generate: port(),
    });
    const created = await music.create(stack.actor, { projectId: stack.project.id, title: 'Private', brief: 'private' });
    await music.compose(stack.actor, created.id, { brief: 'private' });
    await expect(music.get(other, created.id)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(music.auditionBytes(other, created.id)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(music.compose(other, created.id, { brief: 'steal' })).rejects.toMatchObject({ httpStatus: 404 });
    await expect(music.compose(reader, created.id, { brief: 'no write' })).rejects.toMatchObject({ httpStatus: 404 });
  });
});
