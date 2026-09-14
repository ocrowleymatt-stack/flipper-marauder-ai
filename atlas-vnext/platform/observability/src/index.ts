export interface RouteTrace {
  traceId: string;
  target: string;
  resolvedRouteId: string;
  attempts: Array<{ provider: string; model: string; outcome: 'selected' | 'skipped' | 'failed' }>;
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
