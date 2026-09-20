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
});
