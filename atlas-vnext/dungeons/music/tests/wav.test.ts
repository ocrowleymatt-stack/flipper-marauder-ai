import { describe, expect, it } from 'vitest';
import { parseMusicScore } from '../src/score.ts';
import { isWavBytes, renderScoreToWav, wavPeakAbs } from '../src/wav.ts';

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
        { pitch: 57, startBeat: 0, durationBeats: 2, velocity: 96 },
        { pitch: 64, startBeat: 2, durationBeats: 2, velocity: 88 },
      ],
    },
  ],
});

describe('WAV audition renderer', () => {
  it('emits stereo RIFF/WAVE with an audible signal', () => {
    const bytes = renderScoreToWav(score);
    expect(isWavBytes(bytes)).toBe(true);
    expect(String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)).toBe('RIFF');
    expect(String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!)).toBe('WAVE');
    const channels = bytes[22]! | (bytes[23]! << 8);
    const bits = bytes[34]! | (bytes[35]! << 8);
    expect(channels).toBe(2);
    expect(bits).toBe(16);
    expect(wavPeakAbs(bytes)).toBeGreaterThan(0.05);
  });

  it('rejects overlapping notes whose aggregate sample work exceeds the polyphony bound', () => {
    const dense = parseMusicScore({
      title: 'Dense overlap',
      tempoBpm: 20,
      timeSignature: [4, 4],
      tracks: [
        {
          name: 'Pad',
          channel: 0,
          program: 48,
          notes: Array.from({ length: 17 }, (_, i) => ({
            pitch: 48 + (i % 12),
            startBeat: 0,
            durationBeats: 80,
            velocity: 40,
          })),
        },
      ],
    });
    expect(() => renderScoreToWav(dense)).toThrow(/synthesis bound/i);
  });
});
