import type { StreamChunk } from '@atlas-vnext/contracts';
import type { ExecutionContext, ProviderAdapter } from '../types.ts';

/**
 * In-process adapter used to prove streaming/retry invariants.
 * Production HTTP adapters will live in this same layer; they are not shipped in this PR.
 */
export class MockAdapter implements ProviderAdapter {
  constructor(readonly providerId: string = 'mock') {}

  async *stream(model: string, context: ExecutionContext): AsyncGenerator<StreamChunk> {
    yield { type: 'text', text: `${this.providerId}/${model}: ` };
    yield { type: 'text', text: context.prompt.slice(0, 48) };
  }
}
