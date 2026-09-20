import type { ConversationHistoryTurn, StreamChunk } from '@atlas-vnext/contracts';
import type { ExecutionContext, ProviderAdapter } from '../types.ts';

/**
 * In-process adapter used to prove streaming/retry invariants and to drive
 * the local conversation spine without live API keys.
 */
export class MockAdapter implements ProviderAdapter {
  constructor(
    readonly providerId: string = 'mock',
    private readonly options: { delayMs?: number } = {},
  ) {}

  async *stream(model: string, context: ExecutionContext): AsyncGenerator<StreamChunk> {
    const reply = composeReply(this.providerId, model, context);
    const pieces = splitForStream(reply);
    for (const text of pieces) {
      if (this.options.delayMs) {
        await delay(this.options.delayMs);
      }
      yield { type: 'text', text };
    }
    const outputTokens = estimateTokens(reply);
    const inputTokens = estimateTokens(context.prompt);
    yield {
      type: 'usage',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function composeReply(provider: string, model: string, context: ExecutionContext): string {
  const prompt = context.prompt.trim() || '(empty prompt)';
  const remembered = rememberFromHistory(prompt, context.history ?? []);
  if (remembered) return remembered;
  const score = musicScoreReply(prompt, context.systemPrompt);
  if (score) return score;
  const tools = context.priorToolResults?.length
    ? `\n\nTool results: ${context.priorToolResults.map((row) => `${row.toolId}:${row.status}`).join(', ')}.`
    : '';
  return `${provider}/${model} received your message.\n\n${prompt}${tools}`;
}

function musicScoreReply(prompt: string, systemPrompt?: string): string | null {
  if (!/MusicScore JSON/i.test(systemPrompt ?? '')) return null;
  const previous = extractPreviousScore(prompt);
  const instruction = prompt.match(/Revision instruction:\n([\s\S]*?)\nOriginal brief:/i)?.[1]?.trim() ?? '';
  if (previous && instruction) {
    const next = applyMockRevision(previous, instruction);
    if (next) return JSON.stringify(next);
  }
  const bpmMatch = prompt.match(/\b(\d{2,3})\s*BPM\b/i);
  const tempoBpm = clamp(Number(bpmMatch?.[1] ?? 90), 20, 300);
  const keyMatch = prompt.match(/\bin\s+([A-G](?:#|b)?\s*(?:minor|major|min|maj)?)/i);
  const key = keyMatch?.[1]?.trim() || 'A minor';
  const secondsMatch = prompt.match(/(\d+)\s*-?\s*second/i);
  const seconds = clamp(Number(secondsMatch?.[1] ?? 8), 4, 30);
  const beats = Math.max(8, Math.round((seconds * tempoBpm) / 60));
  const titleMatch = prompt.match(/(?:song|piece|track|tune)\s+(?:about|in|called)\s+([^\n.]+)/i);
  const title = (titleMatch?.[1] ?? 'Audition').replace(/\s+/g, ' ').trim().slice(0, 72);
  const notes: Array<{ pitch: number; startBeat: number; durationBeats: number; velocity: number }> = [];
  const motif = [57, 60, 64, 69, 64, 60, 57, 45];
  for (let beat = 0; beat < beats; beat += 1) {
    notes.push({
      pitch: motif[beat % motif.length]!,
      startBeat: beat,
      durationBeats: 0.9,
      velocity: beat % 8 === 0 ? 96 : 78,
    });
  }
  return JSON.stringify({
    title: title || 'Audition',
    tempoBpm,
    timeSignature: [4, 4],
    key,
    tracks: [{ name: 'Piano', channel: 0, program: 0, notes }],
  });
}

function extractPreviousScore(prompt: string): {
  title: string;
  tempoBpm: number;
  timeSignature: [number, number];
  key?: string;
  tracks: Array<{
    name: string;
    channel: number;
    program: number;
    notes: Array<{ pitch: number; startBeat: number; durationBeats: number; velocity: number }>;
  }>;
} | null {
  const block = prompt.match(/Existing MusicScore JSON:\n([\s\S]*?)\n\nRevision instruction:/i)?.[1];
  if (!block) return null;
  try {
    const parsed = JSON.parse(block) as ReturnType<typeof extractPreviousScore>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tracks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function applyMockRevision(
  score: NonNullable<ReturnType<typeof extractPreviousScore>>,
  instruction: string,
): NonNullable<ReturnType<typeof extractPreviousScore>> | null {
  const next = JSON.parse(JSON.stringify(score)) as NonNullable<ReturnType<typeof extractPreviousScore>>;
  const bpm = instruction.match(/\b(\d{2,3})\s*bpm\b/i);
  if (bpm) next.tempoBpm = clamp(Number(bpm[1]), 20, 300);
  else if (/slower/i.test(instruction)) next.tempoBpm = clamp(Math.round(next.tempoBpm * 0.8), 20, 300);
  else if (/faster/i.test(instruction)) next.tempoBpm = clamp(Math.round(next.tempoBpm * 1.2), 20, 300);
  if (/add (the |some |a )?(strings|violins?)/i.test(instruction) && !next.tracks.some((track) => /string/i.test(track.name))) {
    next.tracks.push({
      name: 'Strings',
      channel: 1,
      program: 48,
      notes: [{ pitch: 57, startBeat: 0, durationBeats: 8, velocity: 60 }],
    });
  }
  if (/remove (the )?(vocals?|voice|choir)/i.test(instruction)) {
    const kept = next.tracks.filter((track) => !/vocal|voice|choir|sing/i.test(track.name));
    if (kept.length) next.tracks = kept;
  }
  return next;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function rememberFromHistory(prompt: string, history: ConversationHistoryTurn[]): string | null {
  const blob = [...history.map((turn) => `${turn.role}: ${turn.content}`), `user: ${prompt}`].join('\n');
  if (/\b(what did i say my dog|dog'?s name was)\b/i.test(prompt)) {
    const named = blob.match(/dog['’]?s name is\s+([A-Z0-9][A-Z0-9_-]*)/i);
    if (named?.[1]) return named[1];
  }
  if (/\b(which of those findings|strongest (evidence|finding)|those findings is strongest)\b/i.test(prompt)) {
    const confirmed = [...blob.matchAll(/\*\*([^*]+)\*\*[^\n]*\((confirmed|likely|possible)\)/gi)];
    const ranked = confirmed.sort((a, b) => rankConfidence(b[2] ?? '') - rankConfidence(a[2] ?? ''));
    if (ranked[0]?.[1]) {
      return `The strongest finding is ${ranked[0][1].trim()} (${ranked[0][2]}).`;
    }
    const strongestLine = blob.match(/Strongest finding:\s*(.+)/i);
    if (strongestLine?.[1]) return `The strongest finding is ${strongestLine[1].trim()}`;
  }
  if (/\bwhat were we researching\b/i.test(prompt)) {
    const researching = blob.match(/Researching:\s*(.+)/i) ?? blob.match(/Research(?: the)? (.+?) using multiple/i);
    if (researching?.[1]) return `We were researching ${researching[1].replace(/[.?!].*$/, '').trim()}.`;
  }
  return null;
}

function rankConfidence(value: string): number {
  if (/confirmed/i.test(value)) return 3;
  if (/likely/i.test(value)) return 2;
  return 1;
}

function splitForStream(text: string): string[] {
  const parts = text.split(/(\s+)/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts : [text];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
