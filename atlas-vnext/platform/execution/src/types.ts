import type { StreamChunk } from '@atlas-vnext/contracts';

export interface ExecutionContext {
  prompt: string;
  systemPrompt?: string;
  tools?: Array<{
    id: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  signal?: AbortSignal;
  traceId?: string;
}

/**
 * Provider transport adapter. Concrete HTTP/SSE/NDJSON implementations
 * belong beside this interface in the execution layer — never in Nexus.
 */
export interface ProviderAdapter {
  readonly providerId: string;
  stream(model: string, context: ExecutionContext): AsyncGenerator<StreamChunk>;
}
