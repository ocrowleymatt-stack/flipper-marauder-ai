import { describe, expect, it } from 'vitest';
import { buildMidiFile, isMidiBytes } from '../src/midi.ts';
import { parseMusicScore } from '../src/score.ts';

const score = parseMusicScore({
  title: 'A minor piano',
  tempoBpm: 90,
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
        { pitch: 64, startBeat: 2, durationBeats: 2, velocity: 84 },
      ],
    },
  ],
});

describe('MIDI generation', () => {
  it('emits a standards-compliant MThd/MTrk file', () => {
    const bytes = buildMidiFile(score);
    expect(isMidiBytes(bytes)).toBe(true);
    const header = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
    expect(header).toBe('MThd');
    expect(bytes[8]).toBe(0);
    expect(bytes[9]).toBe(1);
    expect((bytes[12]! << 8) | bytes[13]!).toBe(480);
    const asText = Buffer.from(bytes).toString('latin1');
    expect(asText).toContain('MTrk');
    expect(asText.match(/MTrk/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('emits same-tick note-offs before note-ons so repeated pitches survive', () => {
    const legato = parseMusicScore({
      title: 'Repeated C',
      tempoBpm: 120,
      timeSignature: [4, 4],
      tracks: [
        {
          name: 'Piano',
          channel: 0,
          program: 0,
          notes: [
            { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 90 },
            { pitch: 60, startBeat: 1, durationBeats: 1, velocity: 80 },
          ],
        },
      ],
    });
    const bytes = buildMidiFile(legato);
    const events: Array<{ tick: number; status: number; pitch: number }> = [];
    let i = 14;
    while (i + 8 < bytes.length) {
      if (bytes[i] === 0x4d && bytes[i + 1] === 0x54 && bytes[i + 2] === 0x72 && bytes[i + 3] === 0x6b) {
        const length = (bytes[i + 4]! << 24) | (bytes[i + 5]! << 16) | (bytes[i + 6]! << 8) | bytes[i + 7]!;
        const start = i + 8;
        const end = start + length;
        let cursor = start;
        let tick = 0;
        while (cursor < end) {
          let delta = 0;
          while (cursor < end) {
            const value = bytes[cursor]!;
            cursor += 1;
            delta = (delta << 7) | (value & 0x7f);
            if ((value & 0x80) === 0) break;
          }
          tick += delta;
          const status = bytes[cursor]!;
          if (status === 0xff) {
            cursor += 1;
            const type = bytes[cursor]!;
            cursor += 1;
            const len = bytes[cursor]!;
            cursor += 1 + len;
            if (type === 0x2f) break;
            continue;
          }
          if ((status & 0xf0) === 0x90 || (status & 0xf0) === 0x80) {
            events.push({ tick, status: status & 0xf0, pitch: bytes[cursor + 1]! });
            cursor += 3;
            continue;
          }
          if ((status & 0xf0) === 0xc0) {
            cursor += 2;
            continue;
          }
          cursor += 1;
        }
        i = end;
        continue;
      }
      i += 1;
    }
    const boundary = events.filter((event) => event.tick === 480 && event.pitch === 60);
    expect(boundary.map((event) => event.status)).toEqual([0x80, 0x90]);
  });
});
