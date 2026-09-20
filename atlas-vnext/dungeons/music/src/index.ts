import { randomUUID } from 'node:crypto';
import type { DungeonId, DungeonRegistration, MusicScore, MusicScorePort } from '@atlas-vnext/contracts';
import type { FilesService } from '@atlas-vnext/files';
import type { DungeonRecordRow, PersistenceActor, PlatformPersistence } from '@atlas-vnext/persistence';
import { AuthorityEngine, EffectivePolicyEngine } from '@atlas-vnext/permissions';
import type { ProjectService } from '@atlas-vnext/projects';
import {
  isMusicRegenerateFollowup,
  isMusicRevisionFollowup,
  libraryPathsForComposition,
  looksLikeMusicFollowup,
  looksLikeMusicRequest,
  titleFromBrief,
} from './intent.ts';
import { buildMidiFile, isMidiBytes } from './midi.ts';
import { composeMusicReport, isAbortError } from './report.ts';
import { applyDeterministicRevision, parseMusicScore, parseMusicScoreText, scoreDurationSeconds } from './score.ts';
import { isWavBytes, renderScoreToWav } from './wav.ts';

export const dungeonId: DungeonId = 'music';

export const musicDungeon = {
  id: dungeonId,
  title: 'Music',
  description: 'Score-first composition. MIDI and audition WAV derive from a structured score.',
} as const;

export const MUSIC_DUNGEON: DungeonRegistration = {
  id: 'music',
  slug: 'music',
  title: 'Music',
  navLabel: 'Music',
  description: 'Compose a structured score through Nexus. MIDI and WAV are derived. Does not lease GPUs.',
  surface: 'music-studio',
  routes: {
    list: '/api/projects/:projectId/compositions',
    item: '/api/compositions/:id',
    compose: '/api/compositions/:id/compose',
    audition: '/api/compositions/:id/audition',
    midi: '/api/compositions/:id/midi',
  },
  capabilities: ['project.read', 'artifact.read', 'artifact.write'],
  permissions: { read: 'artifact.read', write: 'artifact.write' },
  featureAvailable: true,
};

export const GENERIC_DENY = 'Permission denied.';

export class MusicError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'MusicError';
  }
}

export interface MusicActor extends PersistenceActor {
  principalId: string;
  tenantId: string;
}

export type MusicComposeResult = {
  record: DungeonRecordRow;
  score: MusicScore;
  midi: Uint8Array;
  wav: Uint8Array;
  reportText: string;
  libraryOk: boolean;
};

export class MusicService {
  constructor(
    private readonly deps: {
      persistence: PlatformPersistence;
      projects: ProjectService;
      files: FilesService;
      authority: AuthorityEngine;
      policy: EffectivePolicyEngine;
      generate?: MusicScorePort;
    },
  ) {}

  async list(actor: MusicActor, projectId: string): Promise<DungeonRecordRow[]> {
    await this.requireProject(actor, projectId, 'artifact.read');
    return this.store(actor).list(actor, { workspaceId: projectId, dungeon: 'music', kind: 'composition' });
  }

  async create(actor: MusicActor, input: { projectId: string; title: string; brief: string }) {
    const project = await this.requireProject(actor, input.projectId, 'artifact.write');
    const id = `cmp_${randomUUID()}`;
    return this.store(actor).create(actor, {
      id,
      workspaceId: project.id,
      dungeon: 'music',
      kind: 'composition',
      title: input.title.trim() || titleFromBrief(input.brief) || 'Untitled composition',
      status: 'idle',
      payload: { brief: input.brief },
    });
  }

  async get(actor: MusicActor, id: string): Promise<DungeonRecordRow> {
    const row = await this.store(actor).get(actor, id);
    if (!row || row.dungeon !== 'music') throw new MusicError('not_found', GENERIC_DENY, 404);
    this.authorize(actor, 'artifact.read', row.workspaceId ?? row.id, row.tenantId);
    return row;
  }

  async maybeRunFromConversation(
    actor: MusicActor,
    input: {
      conversationId: string;
      projectId: string | null;
      question: string;
      signal?: AbortSignal;
    },
  ): Promise<{ handled: boolean; text?: string; failed?: boolean }> {
    if (!input.projectId) return { handled: false };
    if (input.signal?.aborted) {
      return { handled: true, failed: true, text: 'Music generation was cancelled.' };
    }
    const isRequest = looksLikeMusicRequest(input.question);
    const isFollowup = looksLikeMusicFollowup(input.question);
    if (!isRequest && !isFollowup) return { handled: false };
    try {
      if (isFollowup && !isRequest) {
        return this.answerFollowup(actor, {
          conversationId: input.conversationId,
          projectId: input.projectId,
          question: input.question,
          signal: input.signal,
        });
      }
      const created = await this.create(actor, {
        projectId: input.projectId,
        title: titleFromBrief(input.question),
        brief: input.question,
      });
      const generated = await this.compose(actor, created.id, {
        brief: input.question,
        conversationId: input.conversationId,
        signal: input.signal,
      });
      return { handled: true, text: generated.reportText };
    } catch (err) {
      if (err instanceof MusicError && (err.code === 'permission_denied' || err.code === 'not_found')) {
        return { handled: true, failed: true, text: err.message };
      }
      if (isAbortError(err) || input.signal?.aborted) {
        return { handled: true, failed: true, text: 'Music generation was cancelled.' };
      }
      if (err instanceof MusicError) {
        return { handled: true, failed: true, text: err.message };
      }
      throw err;
    }
  }

  async compose(
    actor: MusicActor,
    id: string,
    options: {
      brief?: string;
      conversationId?: string | null;
      signal?: AbortSignal;
      previousScore?: MusicScore | null;
      instruction?: string | null;
      admitRun?: boolean;
    } = {},
  ): Promise<MusicComposeResult> {
    if (options.signal?.aborted) throw abortError();
    const record = await this.get(actor, id);
    this.authorize(actor, 'artifact.write', record.workspaceId ?? record.id, record.tenantId);
    const projectId = record.workspaceId;
    if (!projectId) throw new MusicError('malformed', 'Composition is missing a project.');
    const policy = await this.effectivePolicy(actor);
    const write = this.deps.policy.authorize({
      principal: { principalId: actor.principalId, kind: 'user', tenantId: actor.tenantId, workspaceId: projectId },
      capability: 'artifact.write',
      dungeonId: 'music',
      policy,
      resource: { type: 'artifact', id: record.id, tenantId: record.tenantId, workspaceId: projectId },
    });
    if (!write.allowed) throw new MusicError('permission_denied', GENERIC_DENY, 404);

    const storedBrief = typeof record.payload.brief === 'string' ? record.payload.brief : '';
    const brief = options.brief ?? storedBrief;
    const produced = await this.produceScore(
      options.admitRun ? actor.tenantId : undefined,
      brief,
      options.signal,
      this.deps.policy.runtimePrivacy(policy),
      options.previousScore ?? (await this.currentScore(actor, record)),
      options.instruction ?? null,
    );
    if (options.signal?.aborted) throw abortError();

    let midi: Uint8Array;
    let wav: Uint8Array;
    try {
      midi = buildMidiFile(produced.score);
      wav = renderScoreToWav(produced.score);
    } catch (err) {
      if (isAbortError(err) || options.signal?.aborted) throw abortError();
      throw new MusicError('render_failed', 'MIDI or WAV rendering failed.', 400);
    }
    if (!isMidiBytes(midi) || !isWavBytes(wav)) {
      throw new MusicError('render_failed', 'Derived audio failed magic-byte validation.', 400);
    }
    if (options.signal?.aborted) throw abortError();

    const scoreJson = JSON.stringify(produced.score);
    const scoreArt = await this.deps.files.createBinaryArtefact(actor, {
      projectId,
      bytes: new TextEncoder().encode(scoreJson),
      mimeType: 'application/json',
      type: 'music.score',
    });
    const midiArt = await this.deps.files.createBinaryArtefact(actor, {
      projectId,
      bytes: midi,
      mimeType: 'audio/midi',
      type: 'music.midi',
    });
    const wavArt = await this.deps.files.createBinaryArtefact(actor, {
      projectId,
      bytes: wav,
      mimeType: 'audio/wav',
      type: 'music.wav',
    });
    if (!scoreArt.contentHash || !midiArt.contentHash || !wavArt.contentHash) {
      throw new MusicError('malformed', 'Generated composition is missing a content hash.');
    }
    if (options.signal?.aborted) throw abortError();

    const compositionRevision =
      (typeof record.payload.revision === 'number' ? record.payload.revision : 0) + 1;
    const durationSeconds = scoreDurationSeconds(produced.score);
    const updated = await this.store(actor).update(actor, record.id, {
      title: produced.score.title || record.title,
      status: 'completed',
      artefactId: wavArt.id,
      contentHash: wavArt.contentHash,
      conversationId: options.conversationId ?? record.conversationId,
      expectedRevision: record.revision,
      payload: {
        brief: storedBrief || brief,
        title: produced.score.title,
        revision: compositionRevision,
        tempoBpm: produced.score.tempoBpm,
        key: produced.score.key ?? null,
        durationSeconds,
        scoreArtefactId: scoreArt.id,
        midiArtefactId: midiArt.id,
        wavArtefactId: wavArt.id,
        scoreHash: scoreArt.contentHash,
        midiHash: midiArt.contentHash,
        wavHash: wavArt.contentHash,
        source: produced.source,
      },
    });

    try {
      await this.deps.persistence.forActor(actor).provenance.record({
        artefactId: wavArt.id,
        projectId,
        sourceInputs: [record.id, brief.slice(0, 64), produced.source],
        inputManifestHash: wavArt.contentHash,
        provider: 'atlas.music',
        model: produced.source === 'model' ? 'music.score.model' : 'music.score.revision',
        toolCalls: [],
        jobId: null,
        timestamp: new Date().toISOString(),
        traceId: `music:${record.id}:${compositionRevision}`,
        capability: 'music',
      });
    } catch {
      // Provenance is derived; the committed composition remains the source of truth.
    }

    const libraryOk = await this.publishLibrary(actor, updated, {
      scoreArtefactId: scoreArt.id,
      scoreHash: scoreArt.contentHash,
      scoreBytes: Buffer.byteLength(scoreJson, 'utf8'),
      midiArtefactId: midiArt.id,
      midiHash: midiArt.contentHash,
      midiBytes: midi.byteLength,
      wavArtefactId: wavArt.id,
      wavHash: wavArt.contentHash,
      wavBytes: wav.byteLength,
    });
    const reportText = composeMusicReport({
      title: updated.title,
      compositionId: updated.id,
      revision: compositionRevision,
      durationSeconds,
      tempoBpm: produced.score.tempoBpm,
      key: produced.score.key,
      libraryOk,
    });
    return { record: updated, score: produced.score, midi, wav, reportText, libraryOk };
  }

  async auditionBytes(actor: MusicActor, id: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const record = await this.get(actor, id);
    const artefactId = typeof record.payload.wavArtefactId === 'string' ? record.payload.wavArtefactId : record.artefactId;
    if (!artefactId) throw new MusicError('not_found', GENERIC_DENY, 404);
    const bytes = await this.deps.files.readArtefactBytes(actor, artefactId);
    return { bytes, mimeType: 'audio/wav' };
  }

  async midiBytes(actor: MusicActor, id: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const record = await this.get(actor, id);
    const artefactId = typeof record.payload.midiArtefactId === 'string' ? record.payload.midiArtefactId : null;
    if (!artefactId) throw new MusicError('not_found', GENERIC_DENY, 404);
    const bytes = await this.deps.files.readArtefactBytes(actor, artefactId);
    return { bytes, mimeType: 'audio/midi' };
  }

  private async answerFollowup(
    actor: MusicActor,
    input: { conversationId: string; projectId: string; question: string; signal?: AbortSignal },
  ): Promise<{ handled: boolean; text?: string; failed?: boolean }> {
    try {
      await this.requireProject(actor, input.projectId, 'artifact.read');
    } catch (err) {
      if (err instanceof MusicError && (err.code === 'permission_denied' || err.code === 'not_found')) {
        return { handled: true, failed: true, text: err.message };
      }
      throw err;
    }
    const bound = await this.compositionForConversation(actor, input.projectId, input.conversationId);
    if (!bound) return { handled: false };
    const storedBrief = bound.brief;
    const current = await this.get(actor, bound.compositionId);
    const previous = await this.currentScore(actor, current);
    if (isMusicRegenerateFollowup(input.question)) {
      const generated = await this.compose(actor, bound.compositionId, {
        brief: storedBrief || input.question,
        conversationId: input.conversationId,
        signal: input.signal,
        previousScore: null,
      });
      return { handled: true, text: generated.reportText };
    }
    if (isMusicRevisionFollowup(input.question)) {
      const generated = await this.compose(actor, bound.compositionId, {
        brief: storedBrief || bound.title,
        conversationId: input.conversationId,
        signal: input.signal,
        previousScore: previous,
        instruction: input.question,
      });
      return { handled: true, text: generated.reportText };
    }
    return {
      handled: true,
      text: composeMusicReport({
        title: bound.title,
        compositionId: bound.compositionId,
        revision: bound.revision,
        durationSeconds: bound.durationSeconds,
        tempoBpm: bound.tempoBpm,
        key: bound.key,
        libraryOk: true,
      }),
    };
  }

  private async compositionForConversation(actor: MusicActor, projectId: string, conversationId: string) {
    const records = await this.store(actor).list(actor, {
      workspaceId: projectId,
      dungeon: 'music',
      kind: 'composition',
    });
    const mine = records
      .filter((row) => row.conversationId === conversationId && row.status === 'completed')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const latest = mine[0];
    if (!latest) return null;
    return {
      compositionId: latest.id,
      title: latest.title,
      brief: typeof latest.payload.brief === 'string' ? latest.payload.brief : '',
      revision: typeof latest.payload.revision === 'number' ? latest.payload.revision : 1,
      tempoBpm: typeof latest.payload.tempoBpm === 'number' ? latest.payload.tempoBpm : 90,
      durationSeconds: typeof latest.payload.durationSeconds === 'number' ? latest.payload.durationSeconds : 0,
      key: typeof latest.payload.key === 'string' ? latest.payload.key : undefined,
    };
  }

  private async currentScore(actor: MusicActor, record: DungeonRecordRow): Promise<MusicScore | null> {
    const artefactId = typeof record.payload.scoreArtefactId === 'string' ? record.payload.scoreArtefactId : null;
    if (!artefactId) return null;
    try {
      const text = await this.deps.files.readArtefactText(actor, artefactId);
      return parseMusicScoreText(text);
    } catch {
      return null;
    }
  }

  private async produceScore(
    tenantId: string | undefined,
    brief: string,
    signal: AbortSignal | undefined,
    privacy: 'any' | 'local_only',
    previousScore: MusicScore | null,
    instruction: string | null,
  ): Promise<{ score: MusicScore; source: 'model' | 'revision' }> {
    if (signal?.aborted) throw abortError();
    if (previousScore && instruction) {
      const mutated = applyDeterministicRevision(previousScore, instruction);
      if (mutated) return { score: mutated, source: 'revision' };
    }
    if (!this.deps.generate) {
      throw new MusicError('invalid_score', 'Music score generation is unavailable.', 400);
    }
    try {
      const generated = await this.deps.generate.generateScore({
        brief,
        previousScore,
        instruction,
        signal,
        privacy,
        ...(tenantId ? { tenantId } : {}),
      });
      if (signal?.aborted) throw abortError();
      return { score: parseMusicScore(generated.score), source: 'model' };
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) throw isAbortError(err) ? err : abortError();
      if (err instanceof MusicError) throw err;
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code) : '';
      if (code === 'empty_score' || code === 'invalid_score') {
        throw new MusicError(code, 'The model returned no usable score.', 400);
      }
      if (code === 'content_filter') {
        throw new MusicError('invalid_score', 'The model declined this brief. No audio was stored.', 400);
      }
      const message = err instanceof Error ? err.message : String(err);
      if (
        code === 'timeout' ||
        code === 'circuit_open' ||
        /timed out after|\btimeout\b|etimedout|circuit open/i.test(message)
      ) {
        throw new MusicError(
          'timeout',
          'Music score generation timed out. No playable audio was stored.',
          504,
        );
      }
      throw err;
    }
  }

  private async publishLibrary(
    actor: MusicActor,
    record: DungeonRecordRow,
    artefacts: {
      scoreArtefactId: string;
      scoreHash: string;
      scoreBytes: number;
      midiArtefactId: string;
      midiHash: string;
      midiBytes: number;
      wavArtefactId: string;
      wavHash: string;
      wavBytes: number;
    },
  ): Promise<boolean> {
    const projectId = record.workspaceId;
    if (!projectId) return false;
    const paths = libraryPathsForComposition(record.id);
    try {
      await this.deps.files.publishArtefactFile(actor, {
        projectId,
        path: paths.score,
        displayName: `${record.title}.json`,
        artefactId: artefacts.scoreArtefactId,
        contentHash: artefacts.scoreHash,
        mimeType: 'application/json',
        sizeBytes: artefacts.scoreBytes,
      });
      await this.deps.files.publishArtefactFile(actor, {
        projectId,
        path: paths.midi,
        displayName: `${record.title}.mid`,
        artefactId: artefacts.midiArtefactId,
        contentHash: artefacts.midiHash,
        mimeType: 'audio/midi',
        sizeBytes: artefacts.midiBytes,
      });
      await this.deps.files.publishArtefactFile(actor, {
        projectId,
        path: paths.wav,
        displayName: `${record.title}.wav`,
        artefactId: artefacts.wavArtefactId,
        contentHash: artefacts.wavHash,
        mimeType: 'audio/wav',
        sizeBytes: artefacts.wavBytes,
      });
      return true;
    } catch {
      return false;
    }
  }

  private store(actor: MusicActor) {
    return this.deps.persistence.forActor(actor).dungeonRecords;
  }

  private async effectivePolicy(actor: MusicActor) {
    return this.deps.policy.loadForDungeon(actor.tenantId, 'music', (dungeonId) =>
      this.deps.persistence.forActor(actor).privacy.getPolicy(actor, dungeonId),
    );
  }

  private async requireProject(actor: MusicActor, projectId: string, capability: 'artifact.read' | 'artifact.write') {
    if (!actor.tenantId || !actor.principalId) throw new MusicError('permission_denied', GENERIC_DENY, 401);
    const project = await this.deps.projects.get(actor, projectId);
    if (!project) throw new MusicError('not_found', GENERIC_DENY, 404);
    this.authorize(actor, capability, project.id, project.tenantId);
    return project;
  }

  private authorize(actor: MusicActor, capability: 'artifact.read' | 'artifact.write', workspaceId: string, tenantId: string) {
    if (actor.tenantId !== tenantId) throw new MusicError('permission_denied', GENERIC_DENY, 404);
    const verdict = this.deps.authority.decide({
      principal: { principalId: actor.principalId, kind: 'user', tenantId: actor.tenantId, workspaceId },
      capability,
      resource: { type: 'artifact', id: workspaceId, tenantId, workspaceId },
    });
    if (verdict.decision !== 'ALLOW') throw new MusicError('permission_denied', GENERIC_DENY, 404);
  }
}

export {
  looksLikeMusicFollowup,
  looksLikeMusicRequest,
  titleFromBrief,
  libraryPathsForComposition,
  compositionIdFromLibraryPath,
} from './intent.ts';
export { parseMusicScore, parseMusicScoreText, applyDeterministicRevision, scoreDurationSeconds } from './score.ts';
export { buildMidiFile, isMidiBytes } from './midi.ts';
export { renderScoreToWav, isWavBytes, wavPeakAbs } from './wav.ts';

function abortError(): Error & { code: string } {
  const error = new Error('aborted') as Error & { code: string };
  error.code = 'aborted';
  return error;
}
