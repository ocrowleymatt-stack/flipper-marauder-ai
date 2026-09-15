import { DEFAULT_OPERATIONAL_LIMITS, type OperationalLimits } from '@atlas-vnext/contracts';
import { logPlatform, platformMetrics } from '@atlas-vnext/observability';
import { PlatformHttpError } from './errors.ts';

export type RateClass =
  | 'auth'
  | 'runs'
  | 'generation'
  | 'upload'
  | 'retrieval'
  | 'tools'
  | 'approvals'
  | 'documents';

export interface RateLimitConfig {
  windowMs: number;
  limits: Record<RateClass, number>;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  windowMs: 60_000,
  limits: {
    auth: 30,
    runs: 60,
    generation: 30,
    upload: 30,
    retrieval: 60,
    tools: 120,
    approvals: 60,
    documents: 60,
  },
};

/**
 * Platform-owned limiter. Keys are server-derived tenant + actor ids, never a
 * client-supplied tenant header. Per-process: multi-instance deployments get
 * N× the configured ceiling unless a shared limiter is added later.
 */
export class PlatformRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly config: RateLimitConfig = DEFAULT_RATE_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  hit(rateClass: RateClass, tenantId: string, actorId: string): void {
    const tenant = tenantId.trim();
    const actor = actorId.trim();
    if (!tenant || !actor) {
      throw new PlatformHttpError('unauthenticated', 'Authentication required.', 401);
    }
    const limit = this.config.limits[rateClass];
    const key = `${rateClass}:${tenant}:${actor}`;
    const now = this.now();
    let row = this.buckets.get(key);
    if (!row || row.resetAt <= now) {
      row = { count: 0, resetAt: now + this.config.windowMs };
      this.buckets.set(key, row);
    }
    row.count += 1;
    if (row.count > limit) {
      platformMetrics.inc('atlas_rate_limited_total', { route_class: rateClass, outcome: 'rejected' });
      logPlatform('rate.limited', { routeClass: rateClass, tenantId: tenant, actorId: actor }, 'warn');
      throw new PlatformHttpError('rate_limit', 'Rate limit exceeded.', 429, true);
    }
  }
}

export class ResourceGuard {
  private readonly streams = new Map<string, number>();
  private readonly runs = new Map<string, number>();

  constructor(
    private readonly limits: OperationalLimits,
    private readonly now: () => number = Date.now,
  ) {
    void this.now;
  }

  beginStream(tenantId: string): () => void {
    return this.track(this.streams, tenantId, this.limits.maxConcurrentStreams, 'Concurrent stream limit reached.');
  }

  beginRun(tenantId: string): () => void {
    return this.track(this.runs, tenantId, this.limits.maxConcurrentRuns, 'Concurrent run limit reached.');
  }

  assertBodySize(bytes: number, kind: 'request' | 'upload' | 'generated' | 'tool_args'): void {
    const max =
      kind === 'upload'
        ? this.limits.maxUploadBytes
        : kind === 'generated'
          ? this.limits.maxGeneratedBytes
          : kind === 'tool_args'
            ? this.limits.maxToolArgBytes
            : this.limits.maxRequestBytes;
    if (bytes > max) {
      throw new PlatformHttpError('payload_too_large', `${kind} exceeds the configured limit.`, 413);
    }
  }

  assertContextFiles(count: number): void {
    if (count > this.limits.maxContextFiles) {
      throw new PlatformHttpError('validation', 'Too many context files.', 400);
    }
  }

  private track(map: Map<string, number>, tenantId: string, max: number, message: string): () => void {
    const key = tenantId.trim() || 'unknown';
    const next = (map.get(key) ?? 0) + 1;
    if (next > max) {
      platformMetrics.inc('atlas_resource_rejected_total', { outcome: 'rejected' });
      throw new PlatformHttpError('rate_limit', message, 429, true);
    }
    map.set(key, next);
    return () => {
      const current = map.get(key) ?? 1;
      if (current <= 1) map.delete(key);
      else map.set(key, current - 1);
    };
  }
}

export function rateClassForPath(pathname: string, method = 'GET'): RateClass | null {
  if (pathname.startsWith('/api/health') || pathname.startsWith('/api/metrics')) return null;
  if (pathname.startsWith('/api/session')) return 'auth';
  if (pathname.includes('/generate') || (pathname.includes('/messages') && method === 'POST')) return 'generation';
  if (pathname.includes('/files') && (method === 'POST' || method === 'PUT')) return 'upload';
  if (pathname.startsWith('/api/context')) return 'retrieval';
  if (pathname.startsWith('/api/approvals') || pathname.includes('/approve') || pathname.includes('/deny')) {
    return 'approvals';
  }
  if (pathname.startsWith('/api/tools')) return 'tools';
  if (pathname.includes('/documents')) return 'documents';
  if (pathname.startsWith('/api/executions') || pathname.startsWith('/api/conversations')) return 'runs';
  return null;
}

export { DEFAULT_OPERATIONAL_LIMITS };
