import { MUSIC_BOUNDS, type MusicScore } from '@atlas-vnext/contracts';
import { scoreDurationSeconds } from './score.ts';

const SAMPLE_RATE = 22_050;

export function renderScoreToWav(score: MusicScore, maxSeconds = MUSIC_BOUNDS.maxAuditionSeconds): Uint8Array {
  const duration = Math.min(maxSeconds, Math.max(0.25, scoreDurationSeconds(score)));
  if (duration <= 0) {
    throw Object.assign(new Error('Score duration is empty.'), { code: 'render_failed' });
  }
  const frames = Math.max(1, Math.round(duration * SAMPLE_RATE));
  const left = new Float64Array(frames);
  const right = new Float64Array(frames);
  const twoPi = Math.PI * 2;
  const tracks = score.tracks;
  const ampScale = 0.22 / Math.sqrt(Math.max(1, tracks.length));

  for (let t = 0; t < tracks.length; t += 1) {
    const track = tracks[t]!;
    const pan = tracks.length === 1 ? 0.5 : t / Math.max(1, tracks.length - 1);
    const leftGain = Math.cos((pan * Math.PI) / 2);
    const rightGain = Math.sin((pan * Math.PI) / 2);
    for (const note of track.notes) {
      const start = Math.floor((note.startBeat * 60 * SAMPLE_RATE) / score.tempoBpm);
      const end = Math.min(
        frames,
        start + Math.max(8, Math.floor((note.durationBeats * 60 * SAMPLE_RATE) / score.tempoBpm)),
      );
      if (start >= frames || end <= start) continue;
      const hz = midiToHz(note.pitch);
      const peak = (note.velocity / 127) * ampScale;
      const attack = Math.max(4, Math.round(SAMPLE_RATE * 0.008));
      const release = Math.max(8, Math.round(SAMPLE_RATE * 0.05));
      for (let i = start; i < end; i += 1) {
        const local = i - start;
        const length = end - start;
        let env = 1;
        if (local < attack) env = local / attack;
        else if (local > length - release) env = Math.max(0, (length - local) / release);
        const sample = Math.sin(twoPi * hz * (i / SAMPLE_RATE)) * peak * env;
        left[i] = (left[i] ?? 0) + sample * leftGain;
        right[i] = (right[i] ?? 0) + sample * rightGain;
      }
    }
  }

  let peak = 0;
  for (let i = 0; i < frames; i += 1) {
    peak = Math.max(peak, Math.abs(left[i]!), Math.abs(right[i]!));
  }
  if (peak < 1e-4) {
    throw Object.assign(new Error('Rendered audition is silent.'), { code: 'render_failed' });
  }
  const gain = 0.72 / peak;
  const pcm = Buffer.alloc(44 + frames * 4);
  writeWavHeader(pcm, frames, SAMPLE_RATE, 2);
  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    pcm.writeInt16LE(toInt16(left[i]! * gain), offset);
    pcm.writeInt16LE(toInt16(right[i]! * gain), offset + 2);
    offset += 4;
  }
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

export function isWavBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 44) return false;
  const riff = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  const wave = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
  return riff === 'RIFF' && wave === 'WAVE';
}

export function wavPeakAbs(bytes: Uint8Array): number {
  if (!isWavBytes(bytes) || bytes.length <= 44) return 0;
  let peak = 0;
  for (let i = 44; i + 1 < bytes.length; i += 2) {
    const sample = bytes[i]! | (bytes[i + 1]! << 8);
    const signed = sample >= 0x8000 ? sample - 0x10000 : sample;
    peak = Math.max(peak, Math.abs(signed));
  }
  return peak / 32767;
}

function midiToHz(pitch: number): number {
  return 440 * 2 ** ((pitch - 69) / 12);
}

function toInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
}

function writeWavHeader(buf: Buffer, frames: number, sampleRate: number, channels: number): void {
  const dataBytes = frames * channels * 2;
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
}
