import type { ObservedRouteAttempt, RejectedCandidate, RouteDecision } from '@atlas-vnext/contracts';
import { correlationFields } from './context.ts';

export { createRequestId, getRequestContext, patchRequestContext, runWithRequestContext, correlationFields } from './context.ts';
export type { RequestContext } from './context.ts';
export { MetricsRegistry, platformMetrics, classifyRoute } from './metrics.ts';
export type { MetricLabels, MetricSnapshot } from './metrics.ts';

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

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const REDACT_KEY = /password|secret|token|authorization|api[_-]?key|database_url|connectionstring|credential|cookie|set-cookie/i;
const REDACT_BODY_KEY = /^(content|body|text|prompt|payload|message|bytes|filebody|extracted|chunk|source|dump)$/i;

export function redactSecret(value: string): string {
  return value.replace(/:([^:@/]+)@/g, ':***@');
}

export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACT_KEY.test(key) || REDACT_BODY_KEY.test(key)) {
      out[key] = typeof value === 'string' ? (redactSecret(value) === value ? '[redacted]' : redactSecret(value)) : '[redacted]';
      if (typeof value === 'string' && /:/.test(value) && /@/.test(value)) out[key] = redactSecret(value);
      continue;
    }
    if (typeof value === 'string') out[key] = redactSecret(value);
    else out[key] = value;
  }
  return out;
}

/**
 * Structured platform log. Never pass message bodies, credentials, or provider
 * payloads; redaction is a backstop, not a license to log them.
 */
export function logPlatform(
  event: string,
  fields: Record<string, unknown> = {},
  level: LogLevel = 'info',
  sink: (line: string) => void = (line) => {
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.info(line);
  },
): void {
  sink(
    JSON.stringify({
      ts: new Date().toISOString(),
      component: 'atlas-vnext',
      level,
      event,
      ...redactFields({ ...correlationFields(), ...fields }),
    }),
  );
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
