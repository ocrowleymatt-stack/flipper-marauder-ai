import { DEFAULT_OPERATIONAL_LIMITS, musicScoreSchema, type MusicScore, type MusicScorePort, type RouteDecision } from '@atlas-vnext/contracts';
import { classifyProviderFailure, ProviderHttpError } from '@atlas-vnext/execution';
import type { CapabilityRouter, ModelExecutor } from '@atlas-vnext/conversation';
import { PlatformHttpError } from './errors.ts';
import type { ResourceGuard } from './limits.ts';

const SYSTEM = `You write a single MusicScore JSON object for a playable composition.
Return JSON only. No markdown fences. No prose.
The JSON must match:
{"title": string, "tempoBpm": number, "timeSignature": [numerator, denominator], "key": string, "tracks": [{"name": string, "channel": 0-15, "program": 0-127, "notes": [{"pitch": 0-127, "startBeat": number, "durationBeats": number, "velocity": 1-127}]}]}
Bounds: tempo 20-300 BPM, 1-16 tracks, at most 1200 notes, audition under 180 seconds.
Use real pitches and durations so the piece is audible. Do not mention providers, runtimes, or infrastructure.`;

export class NodeMusicScore implements MusicScorePort {
  constructor(
    private readonly router: CapabilityRouter,
    private readonly executor: ModelExecutor,
    private readonly resources?: ResourceGuard,
  ) {}

  async generateScore(input: {
    brief: string;
    previousScore?: MusicScore | null;
    instruction?: string | null;
    signal?: AbortSignal;
    privacy?: 'any' | 'local_only';
    tenantId?: string;
  }): Promise<{ score: MusicScore }> {
    if (input.signal?.aborted) throw abortError();
    const tenantId = input.tenantId?.trim();
    const release = tenantId && this.resources ? this.resources.beginRun(tenantId) : () => {};
    try {
      const decision: RouteDecision = this.router.resolve('nexus/reason', {
        privacy: input.privacy ?? 'any',
      });
      let text = '';
      let generatedBytes = 0;
      const byteLimit = this.resources?.generatedByteLimit() ?? DEFAULT_OPERATIONAL_LIMITS.maxGeneratedBytes;
      try {
        const prompt = composePrompt(input.brief, input.previousScore ?? null, input.instruction ?? null);
        for await (const chunk of this.executor.execute(
          decision,
          {
            prompt,
            systemPrompt: SYSTEM,
            signal: input.signal,
          },
          {
            onAttempt() {
              return undefined;
            },
          },
        )) {
          if (input.signal?.aborted) throw abortError();
          if (chunk.type === 'text' && chunk.text) {
            const extra = Buffer.byteLength(chunk.text, 'utf8');
            const projected = generatedBytes + extra;
            if (this.resources) this.resources.assertGeneratedOutput(projected);
            else if (projected > byteLimit) {
              throw new PlatformHttpError('payload_too_large', 'generated exceeds the configured limit.', 413);
            }
            generatedBytes = projected;
            text += chunk.text;
          }
        }
      } catch (err) {
        if (isAbort(err, input.signal)) throw abortError();
        if (err instanceof PlatformHttpError) throw err;
        const classified = classifyProviderFailure(err);
        const error = new Error(err instanceof Error ? err.message : String(err)) as Error & { code: string };
        error.code = classified.code;
        if (err instanceof ProviderHttpError) error.code = err.failure.code;
        throw error;
      }
      if (!text.trim()) {
        const error = new Error('Model returned no score.') as Error & { code: string };
        error.code = 'empty_score';
        throw error;
      }
      const score = parseGeneratedScore(text);
      return { score };
    } finally {
      release();
    }
  }
}

function composePrompt(brief: string, previous: MusicScore | null, instruction: string | null): string {
  if (previous && instruction) {
    return `Existing MusicScore JSON:\n${JSON.stringify(previous)}\n\nRevision instruction:\n${instruction}\nOriginal brief:\n${brief}\n\nWrite the complete revised MusicScore JSON now.`;
  }
  return `Composition brief:\n${brief}\n\nWrite the MusicScore JSON now.`;
}

function parseGeneratedScore(text: string): MusicScore {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    const error = new Error('Model returned no usable score.') as Error & { code: string };
    error.code = 'invalid_score';
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    const error = new Error('Model returned unparseable score JSON.') as Error & { code: string };
    error.code = 'invalid_score';
    throw error;
  }
  const score = musicScoreSchema.safeParse(parsed);
  if (!score.success) {
    const error = new Error('Model returned an invalid score.') as Error & { code: string };
    error.code = 'invalid_score';
    throw error;
  }
  return score.data;
}

function abortError(): Error & { code: string } {
  const error = new Error('aborted') as Error & { code: string };
  error.code = 'aborted';
  return error;
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!err || typeof err !== 'object') return false;
  const code = 'code' in err ? String((err as { code?: string }).code) : '';
  if (code === 'cancelled' || code === 'aborted') return true;
  return err instanceof Error && /aborted|AbortError|cancelled/i.test(`${err.name} ${err.message}`);
}
