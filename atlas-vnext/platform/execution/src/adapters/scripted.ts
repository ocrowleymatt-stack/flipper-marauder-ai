import type { StreamChunk } from '@atlas-vnext/contracts';
import type { ExecutionContext, ProviderAdapter } from '../types.ts';

export type ScriptedStep =
  | StreamChunk
  | { type: 'error'; message: string }
  | { type: 'delay'; ms: number };

/**
 * Deterministic adapter for execution and spine tests. Never used by Nexus.
 */
export class ScriptedAdapter implements ProviderAdapter {
  constructor(
    readonly providerId: string,
    private readonly script: ScriptedStep[],
  ) {}

  async *stream(_model: string, context: ExecutionContext): AsyncGenerator<StreamChunk> {
    for (const step of this.script) {
      if (context.signal?.aborted) {
        throw new Error('Execution aborted.');
      }
      if (step.type === 'delay') {
        await new Promise((resolve) => setTimeout(resolve, step.ms));
        continue;
      }
      if (step.type === 'error') {
        throw new Error(step.message);
      }
      yield step;
    }
  }
}
