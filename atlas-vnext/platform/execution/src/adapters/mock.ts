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
  const tools = context.priorToolResults?.length
    ? `\n\nTool results: ${context.priorToolResults.map((row) => `${row.toolId}:${row.status}`).join(', ')}.`
    : '';
  return `${provider}/${model} received your message.\n\n${prompt}${tools}`;
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
