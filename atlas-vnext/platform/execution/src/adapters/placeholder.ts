import type { StreamChunk } from '@atlas-vnext/contracts';
import type { ExecutionContext, ProviderAdapter } from '../types.ts';

/**
 * Explicit placeholders. These providers are not implemented and must not be
 * treated as live. Protocols do not terminate here because there is no protocol.
 */
export class PlaceholderAdapter implements ProviderAdapter {
  constructor(readonly providerId: string) {}

  async *stream(_model: string, _context: ExecutionContext): AsyncGenerator<StreamChunk> {
    throw new Error(`${this.providerId} adapter is a placeholder and is not implemented.`);
  }
}

export const PLACEHOLDER_PROVIDERS = ['runpod', 'forge', 'hetzner'] as const;
