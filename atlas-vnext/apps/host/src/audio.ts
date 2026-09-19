import type { AudioRenderRequest, AudioRenderResult } from '@atlas-vnext/contracts';
import type { AudioRenderPort } from '@atlas-vnext/dungeon-music';

const SAMPLE_RATE = 22_050;
const CHANNELS = 2;

export class NodeAudioRender implements AudioRenderPort {
  constructor(
    private readonly env: Record<string, string | undefined> = {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async render(input: AudioRenderRequest, signal?: AbortSignal): Promise<AudioRenderResult> {
    const gpu = await this.tryAceStep(input, signal);
    if (gpu?.status === 'rendered') return gpu;
    const durationMs = durationFrom(input);
    const wav = encodeStereoWav(auditionSamples(input, durationMs), SAMPLE_RATE);
    return {
      status: 'rendered',
      bytes: wav,
      mimeType: 'audio/wav',
      renderer: 'local-audition',
      durationMs,
      detail: gpu?.detail ?? gpuUnavailableDetail(this.env),
    };
  }

  private async tryAceStep(input: AudioRenderRequest, signal?: AbortSignal): Promise<AudioRenderResult | null> {
    const base = this.env.ACE_STEP_URL?.trim() || this.env.ATLAS_MUSIC_RENDER_URL?.trim();
    if (!base) return null;
    try {
      const response = await this.fetchImpl(`${base.replace(/\/$/, '')}/release_task`, {
        method: 'POST',
        signal,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          task_type: 'text2music',
          prompt: `${input.title}. ${input.brief}. ${input.instruction ?? ''}`.slice(0, 1_000),
          format: 'wav',
        }),
      });
      if (!response.ok) {
        return {
          status: 'failed',
          bytes: null,
          mimeType: null,
          renderer: 'ace-step',
          durationMs: null,
          detail: `Audio renderer returned HTTP ${response.status}.`,
        };
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('audio/') || contentType.includes('octet-stream')) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength < 64) return null;
        return {
          status: 'rendered',
          bytes,
          mimeType: contentType.split(';')[0] ?? 'audio/wav',
          renderer: 'ace-step',
          durationMs: null,
          detail: 'Rendered by the configured audio endpoint.',
        };
      }
      return null;
    } catch (err) {
      return {
        status: 'failed',
        bytes: null,
        mimeType: null,
        renderer: 'ace-step',
        durationMs: null,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function gpuUnavailableDetail(env: Record<string, string | undefined>): string {
  if (env.ACE_STEP_URL || env.ATLAS_MUSIC_RENDER_URL) {
    return 'GPU renderer did not return audio. Local stereo WAV audition is stored instead.';
  }
  return 'Playable stereo WAV audition. Dedicated GPU music render is not configured on this host.';
}

function durationFrom(input: AudioRenderRequest): number {
  const source = `${input.brief} ${input.instruction ?? ''} ${input.compositionText}`;
  if (/\bshort\b|\b6s\b|\bfew seconds\b/i.test(source)) return 4_000;
  if (/\blong\b|\b30s\b/i.test(source)) return 8_000;
  return 6_000;
}

function auditionSamples(input: AudioRenderRequest, durationMs: number): Float32Array {
  const frames = Math.max(SAMPLE_RATE, Math.round((SAMPLE_RATE * durationMs) / 1000));
  const out = new Float32Array(frames * CHANNELS);
  const text = `${input.title} ${input.brief} ${input.instruction ?? ''} ${input.compositionText}`.toLowerCase();
  let root = 110;
  if (/dark|slow|cinematic|drone/.test(text)) root = 73.4;
  if (/bright|fast|allegro/.test(text)) root = 196;
  if (/slower/.test(text)) root *= 0.85;
  const fifth = root * 1.5;
  const beat = /slow/.test(text) ? 1.6 : 2.4;
  for (let i = 0; i < frames; i += 1) {
    const t = i / SAMPLE_RATE;
    const env = Math.min(1, t * 3) * Math.max(0, 1 - t / (durationMs / 1000));
    const pulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * (beat / 2) * t);
    const left = Math.sin(2 * Math.PI * root * t) * 0.35 * env * pulse;
    const right = Math.sin(2 * Math.PI * fifth * t + 0.2) * 0.28 * env;
    out[i * 2] = left;
    out[i * 2 + 1] = right;
  }
  return out;
}

export function encodeStereoWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * CHANNELS * 2, true);
  view.setUint16(32, CHANNELS * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}
