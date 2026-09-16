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
