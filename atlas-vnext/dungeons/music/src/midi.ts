import { MUSIC_BOUNDS, type MusicScore } from '@atlas-vnext/contracts';
import { countNotes } from './score.ts';

const PPQ = MUSIC_BOUNDS.ppq;

export function buildMidiFile(score: MusicScore): Uint8Array {
  if (countNotes(score) > MUSIC_BOUNDS.maxNotes) {
    throw Object.assign(new Error('MIDI exceeds the note bound.'), { code: 'render_failed' });
  }
  const tracks = [tempoTrack(score), ...score.tracks.map((track) => noteTrack(track, PPQ))];
  const header = chunk('MThd', [
    ...u16(1),
    ...u16(tracks.length),
    ...u16(PPQ),
  ]);
  const body = tracks.map((track) => chunk('MTrk', track));
  return Uint8Array.from([...header, ...body.flat()]);
}

export function isMidiBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 14 && bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64;
}

function tempoTrack(score: MusicScore): number[] {
  const micros = Math.round(60_000_000 / score.tempoBpm);
  const nn = score.timeSignature[0];
  const dd = Math.round(Math.log2(score.timeSignature[1]));
  return [
    ...delta(0),
    0xff,
    0x51,
    0x03,
    (micros >> 16) & 0xff,
    (micros >> 8) & 0xff,
    micros & 0xff,
    ...delta(0),
    0xff,
    0x58,
    0x04,
    nn,
    dd,
    0x18,
    0x08,
    ...delta(0),
    0xff,
    0x2f,
    0x00,
  ];
}

function noteTrack(
  track: { channel: number; program: number; notes: Array<{ pitch: number; startBeat: number; durationBeats: number; velocity: number }> },
  ppq: number,
): number[] {
  const channel = track.channel & 0x0f;
  type Event = { tick: number; order: number; bytes: number[] };
  const events: Event[] = [
    { tick: 0, order: 0, bytes: [0xc0 | channel, track.program & 0x7f] },
  ];
  for (const note of track.notes) {
    const start = Math.max(0, Math.round(note.startBeat * ppq));
    const duration = Math.max(1, Math.round(note.durationBeats * ppq));
    events.push({
      tick: start,
      order: 2,
      bytes: [0x90 | channel, note.pitch & 0x7f, note.velocity & 0x7f],
    });
    events.push({
      tick: start + duration,
      order: 1,
      bytes: [0x80 | channel, note.pitch & 0x7f, 0x40],
    });
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const out: number[] = [];
  let cursor = 0;
  for (const event of events) {
    out.push(...delta(event.tick - cursor), ...event.bytes);
    cursor = event.tick;
  }
  out.push(...delta(0), 0xff, 0x2f, 0x00);
  return out;
}

function chunk(type: string, data: number[]): number[] {
  const bytes = [...type.split('').map((ch) => ch.charCodeAt(0)), ...u32(data.length), ...data];
  return bytes;
}

function delta(value: number): number[] {
  let n = Math.max(0, Math.floor(value));
  const parts = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    parts.push((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return parts.reverse();
}

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}
