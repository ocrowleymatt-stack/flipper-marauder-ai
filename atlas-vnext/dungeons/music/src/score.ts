import { MUSIC_BOUNDS, musicScoreSchema, type MusicScore, type MusicTrack } from '@atlas-vnext/contracts';

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw Object.assign(new Error('Score JSON is missing.'), { code: 'invalid_score' });
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    throw Object.assign(new Error('Score JSON is unparseable.'), { code: 'invalid_score' });
  }
}

export function parseMusicScore(input: unknown): MusicScore {
  const parsed = musicScoreSchema.safeParse(input);
  if (!parsed.success) {
    throw Object.assign(new Error('Score failed validation.'), { code: 'invalid_score' });
  }
  const notes = countNotes(parsed.data);
  if (notes === 0) {
    throw Object.assign(new Error('Score has no notes.'), { code: 'invalid_score' });
  }
  return parsed.data;
}

export function parseMusicScoreText(text: string): MusicScore {
  if (!text.trim()) {
    throw Object.assign(new Error('Model returned no score.'), { code: 'empty_score' });
  }
  return parseMusicScore(extractJsonObject(text));
}

export function countNotes(score: MusicScore): number {
  return score.tracks.reduce((sum, track) => sum + track.notes.length, 0);
}

export function scoreDurationSeconds(score: MusicScore): number {
  let maxBeat = 0;
  for (const track of score.tracks) {
    for (const note of track.notes) {
      maxBeat = Math.max(maxBeat, note.startBeat + note.durationBeats);
    }
  }
  if (maxBeat <= 0) return 0;
  return (maxBeat * 60) / score.tempoBpm;
}

export function cloneScore(score: MusicScore): MusicScore {
  return structuredClone(score);
}

export function applyDeterministicRevision(score: MusicScore, instruction: string): MusicScore | null {
  const t = instruction.trim();
  const next = cloneScore(score);
  let changed = false;

  const bpmMatch = t.match(/\b(\d{2,3})\s*bpm\b/i);
  if (bpmMatch) {
    next.tempoBpm = clampTempo(Number(bpmMatch[1]));
    changed = true;
  } else if (/\bslower\b/i.test(t)) {
    next.tempoBpm = clampTempo(next.tempoBpm * 0.8);
    changed = true;
  } else if (/\bfaster\b/i.test(t)) {
    next.tempoBpm = clampTempo(next.tempoBpm * 1.2);
    changed = true;
  }

  if (/\badd (the |some |a )?(strings|violins?|orchestra)\b/i.test(t)) {
    if (!next.tracks.some((track) => isStringsTrack(track))) {
      next.tracks.push(stringsPad(next));
      changed = true;
    }
  }

  if (/\bremove (the )?(vocals?|voice|singing|choir)\b/i.test(t)) {
    const kept = next.tracks.filter((track) => !isVocalTrack(track));
    if (kept.length > 0 && kept.length < next.tracks.length) {
      next.tracks = kept;
      changed = true;
    }
  }

  if (/\bmake (the |this )?(chorus|hook) bigger\b/i.test(t)) {
    const maxBeat = scoreDurationBeats(next);
    const chorusStart = maxBeat * 0.5;
    for (const track of next.tracks) {
      for (const note of track.notes) {
        if (note.startBeat >= chorusStart) {
          note.velocity = Math.min(127, Math.round(note.velocity * 1.25));
          changed = true;
        }
      }
    }
  }

  if (!changed) return null;
  if (next.tracks.length > MUSIC_BOUNDS.maxTracks) next.tracks = next.tracks.slice(0, MUSIC_BOUNDS.maxTracks);
  return parseMusicScore(next);
}

function clampTempo(value: number): number {
  return Math.min(MUSIC_BOUNDS.maxTempoBpm, Math.max(MUSIC_BOUNDS.minTempoBpm, Math.round(value)));
}

function scoreDurationBeats(score: MusicScore): number {
  let maxBeat = 0;
  for (const track of score.tracks) {
    for (const note of track.notes) maxBeat = Math.max(maxBeat, note.startBeat + note.durationBeats);
  }
  return maxBeat;
}

function isStringsTrack(track: MusicTrack): boolean {
  return /string|violin|viola|cello|orchestra/i.test(track.name) || (track.program >= 40 && track.program <= 51);
}

function isVocalTrack(track: MusicTrack): boolean {
  return /vocal|voice|choir|sing/i.test(track.name) || track.program === 52 || track.program === 53 || track.program === 54;
}

function stringsPad(score: MusicScore): MusicTrack {
  const beats = Math.max(4, Math.ceil(scoreDurationBeats(score)));
  const root = score.tracks[0]?.notes[0]?.pitch ?? 57;
  const tonic = Math.max(36, Math.min(72, root - (root % 12) + 9));
  return {
    name: 'Strings',
    channel: Math.min(15, (score.tracks[0]?.channel ?? 0) + 1),
    program: 48,
    notes: [
      { pitch: tonic, startBeat: 0, durationBeats: beats, velocity: 64 },
      { pitch: tonic + 7, startBeat: 0, durationBeats: beats, velocity: 52 },
    ],
  };
}
