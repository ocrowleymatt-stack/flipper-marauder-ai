import type { StreamChunk } from '@atlas-vnext/contracts';
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
    const reply = composeReply(this.providerId, model, context.prompt);
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

function composeReply(provider: string, model: string, prompt: string): string {
  const trimmed = prompt.trim() || '(empty prompt)';
  return `${provider}/${model} received your message.\n\n${trimmed}`;
}

function splitForStream(text: string): string[] {
  const parts = text.split(/(\s+)/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts : [text];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
