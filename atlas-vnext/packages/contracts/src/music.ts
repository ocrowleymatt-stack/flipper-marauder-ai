import { z } from 'zod';

/**
 * Host-injected structured score generation. Nexus still owns WHERE; Execution owns HOW.
 * Music must not call ConversationRuntime.sendMessage or import Execution.
 */
export const MUSIC_BOUNDS = {
  minTempoBpm: 20,
  maxTempoBpm: 300,
  minTracks: 1,
  maxTracks: 16,
  maxNotes: 1200,
  maxAuditionSeconds: 180,
  ppq: 480,
  minPitch: 0,
  maxPitch: 127,
} as const;

export const musicNoteSchema = z.object({
  pitch: z.number().int().min(MUSIC_BOUNDS.minPitch).max(MUSIC_BOUNDS.maxPitch),
  startBeat: z.number().min(0),
  durationBeats: z.number().positive(),
  velocity: z.number().int().min(1).max(127),
});
export type MusicNote = z.infer<typeof musicNoteSchema>;

export const musicTrackSchema = z.object({
  name: z.string().min(1).max(64),
  channel: z.number().int().min(0).max(15),
  program: z.number().int().min(0).max(127),
  notes: z.array(musicNoteSchema).min(1),
});
export type MusicTrack = z.infer<typeof musicTrackSchema>;

export const musicScoreSchema = z
  .object({
    title: z.string().min(1).max(120),
    tempoBpm: z.number().min(MUSIC_BOUNDS.minTempoBpm).max(MUSIC_BOUNDS.maxTempoBpm),
    timeSignature: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    key: z.string().min(1).max(24).optional(),
    tracks: z.array(musicTrackSchema).min(MUSIC_BOUNDS.minTracks).max(MUSIC_BOUNDS.maxTracks),
  })
  .superRefine((score, ctx) => {
    let notes = 0;
    for (const track of score.tracks) notes += track.notes.length;
    if (notes > MUSIC_BOUNDS.maxNotes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Score exceeds ${MUSIC_BOUNDS.maxNotes} notes.`,
      });
    }
  });
export type MusicScore = z.infer<typeof musicScoreSchema>;

export interface MusicScorePort {
  generateScore(input: {
    brief: string;
    previousScore?: MusicScore | null;
    instruction?: string | null;
    signal?: AbortSignal;
    privacy?: 'any' | 'local_only';
    tenantId?: string;
  }): Promise<{ score: MusicScore }>;
}
