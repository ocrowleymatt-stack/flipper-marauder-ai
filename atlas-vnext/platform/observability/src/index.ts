import type { ObservedRouteAttempt, RejectedCandidate, RouteDecision } from '@atlas-vnext/contracts';

export interface RouteTrace {
  traceId: string;
  target: string;
  resolvedRouteId: string;
  /** Actual attempted providers, including skips/failures — not only the winner. */
  attempts: ObservedRouteAttempt[];
  rejectedCandidates: RejectedCandidate[];
  selectedProvider?: string;
  selectedModel?: string;
  costClass?: string;
  latencyClass?: string;
}

export interface ObservabilitySink {
  recordRoute(trace: RouteTrace): void;
}

export class ObservabilityNotImplementedError extends Error {
  constructor() {
    super('platform/observability persistence is deferred; the contract is the sink interface.');
    this.name = 'ObservabilityNotImplementedError';
  }
}

/** In-memory route log. Persistence is deferred; this locks observability of rejects. */
export class MemoryRouteLog implements ObservabilitySink {
  private readonly traces: RouteTrace[] = [];

  recordRoute(trace: RouteTrace): void {
    this.traces.push({
      ...trace,
      attempts: [...trace.attempts],
      rejectedCandidates: [...trace.rejectedCandidates],
    });
  }

  list(): RouteTrace[] {
    return this.traces.map((trace) => ({
      ...trace,
      attempts: [...trace.attempts],
      rejectedCandidates: [...trace.rejectedCandidates],
    }));
  }

  last(): RouteTrace | undefined {
    const trace = this.traces.at(-1);
    return trace
      ? {
          ...trace,
          attempts: [...trace.attempts],
          rejectedCandidates: [...trace.rejectedCandidates],
        }
      : undefined;
  }
}

export function routeTraceFromDecision(
  decision: RouteDecision,
  attempts: ObservedRouteAttempt[] = [],
): RouteTrace {
  return {
    traceId: decision.traceId,
    target: decision.target,
    resolvedRouteId: decision.resolvedRouteId,
    attempts,
    rejectedCandidates: [...(decision.rejectedCandidates ?? [])],
    selectedProvider: decision.provider,
    selectedModel: decision.model,
  };
}
