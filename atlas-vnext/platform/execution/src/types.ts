import type { ExecutionAttempt, ProviderHealth, RouteDecision, StreamChunk } from '@atlas-vnext/contracts';

export interface ExecutionContext {
  prompt: string;
  systemPrompt?: string;
  tools?: Array<{
    id: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  priorToolResults?: Array<{
    callId: string;
    toolId: string;
    arguments?: Record<string, unknown>;
    status: string;
    resultRef?: string | null;
    output?: unknown;
    round?: number;
  }>;
  signal?: AbortSignal;
  traceId?: string;
  /**
   * Last attempt index already recorded for this execution. The broker continues
   * from this value so later tool rounds do not reuse index 1 and overwrite
   * prior `emittedVisibleOutput` records.
   */
  attemptIndexBase?: number;
  /**
   * Sticky visible-output flag from earlier rounds (reasoning or assistant text).
   * Failover is forbidden once this is true, even if the current round emits
   * only tool calls with empty assembled text.
   */
  visibleOutputAlready?: boolean;
}

/**
 * Provider transport adapter. Concrete HTTP/SSE/NDJSON implementations
 * belong beside this interface in the execution layer — never in Nexus.
 */
export interface ProviderAdapter {
  readonly providerId: string;
  stream(model: string, context: ExecutionContext): AsyncGenerator<StreamChunk>;
}

/**
 * Lifecycle observer for a single broker invocation.
 * Conversation/domain persistence uses this; Nexus never sees it.
 */
export interface ExecutionObserver {
  onAttempt(
    attempt: Pick<ExecutionAttempt, 'index' | 'provider' | 'model' | 'outcome' | 'error' | 'emittedVisibleOutput'>,
  ): void;
  onSelected?(decision: Pick<RouteDecision, 'provider' | 'model'>): void;
}

export interface HealthObserver {
  onProviderHealth(provider: string, health: ProviderHealth, detail?: string): void;
}

export interface ProviderHealthSnapshot {
  provider: string;
  health: ProviderHealth;
  checkedAt: string;
  detail?: string;
  circuitOpen?: boolean;
}
