import type { ExecutionIntent } from '@atlas/contracts';

export type ProviderHealth = 'healthy' | 'configured' | 'authentication_failure' | 'unavailable';
export type ProviderErrorKind =
  | 'timeout'
  | 'unavailable'
  | 'abrupt-end'
  | 'invalid-request'
  | 'context-length'
  | 'cancelled';

export interface ProviderDescriptor {
  id: string;
  local: boolean;
  capabilities: string[];
  supportsTools: boolean;
  supportsVision: boolean;
}

export type ProviderChunk =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; callId: string; tool: string; input: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number };

export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  execute(intent: ExecutionIntent, signal: AbortSignal): AsyncIterable<ProviderChunk>;
  probe(signal: AbortSignal): Promise<{ health: ProviderHealth; reason?: string; checkedAt: string }>;
}
