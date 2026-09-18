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

export interface RateLimiterBounds {
  /** Hard cap on live bucket entries for this process. */
  maxBuckets?: number;
  /** Max entries inspected per opportunistic sweep. */
  sweepBatch?: number;
  /** Minimum time between opportunistic expired-bucket sweeps. */
  sweepIntervalMs?: number;
}

export const DEFAULT_RATE_LIMIT_MAX_BUCKETS = 4_096;
export const DEFAULT_RATE_LIMIT_SWEEP_BATCH = 64;
export const DEFAULT_RATE_LIMIT_SWEEP_INTERVAL_MS = 250;

interface RateBucket {
  count: number;
  resetAt: number;
  touchedAt: number;
  tenantId: string;
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
 * Reserved tenant slot for unauthenticated rate-limit accounting.
 * Never a real host tenant: anonymous traffic must not share authenticated
 * tenant/principal buckets.
 */
export const ANONYMOUS_RATE_TENANT = '__atlas_anonymous__';

export type RateLimitIdentityKind = 'authenticated' | 'anonymous' | 'bootstrap' | 'local';

export interface RateLimitIdentity {
  kind: RateLimitIdentityKind;
  tenantId: string;
  actorId: string;
}

/**
 * Normalize a Node-observed socket address. IPv4-mapped IPv6 is collapsed so
 * the same loopback client is not split across `::ffff:127.0.0.1` and
 * `127.0.0.1`. Forwarding headers are intentionally not consulted here.
 */
export function normalizeObservedAddress(remoteAddress: string | undefined): string | null {
  const raw = remoteAddress?.trim();
  if (!raw) return null;
  if (raw.toLowerCase().startsWith('::ffff:')) return raw.slice('::ffff:'.length);
  return raw;
}

/** Loopback or private peer that may be nginx/Docker in front of the host. */
export function isTrustedProxyPeer(ip: string | null): boolean {
  if (!ip) return false;
  const value = ip.toLowerCase();
  if (value === '127.0.0.1' || value === '::1') return true;
  const parts = value.split('.').map((item) => Number(item));
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    if (parts[0] === 10) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
  }
  return value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd');
}

/** First hop of X-Forwarded-For, if it parses as an IP. */
export function firstForwardedHop(forwardedFor: string | undefined): string | null {
  const hop = forwardedFor?.split(',')[0]?.trim().replace(/^"|"$/g, '');
  if (!hop) return null;
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(hop);
  if (v4) return normalizeObservedAddress(v4[1]);
  const v6brack = /^\[([0-9a-f:]+)\](?::\d+)?$/i.exec(hop);
  if (v6brack) return normalizeObservedAddress(v6brack[1]);
  if (/^[0-9a-f:]+$/i.test(hop)) return normalizeObservedAddress(hop);
  return null;
}

/**
 * Client address for native login throttling.
 *
 * Public sockets stay on the observed peer (forwarding headers are ignored).
 * When the peer is a trusted local proxy (loopback / Docker / RFC1918), the
 * first sanitized X-Forwarded-For hop is used so nginx-to-Docker does not
 * collapse every browser into one shared bucket. Identifier throttle remains
 * the non-spoofable brute-force control.
 */
export function loginClientAddress(input: {
  remoteAddress?: string;
  forwardedFor?: string;
}): string | null {
  const peer = normalizeObservedAddress(input.remoteAddress);
  if (isTrustedProxyPeer(peer)) {
    const forwarded = firstForwardedHop(input.forwardedFor);
    if (forwarded) return forwarded;
  }
  return peer;
}

function observedHost(input: {
  pathname: string;
  remoteAddress?: string;
  forwardedFor?: string;
}): string {
  const ip =
    input.pathname === '/api/auth/login'
      ? loginClientAddress({ remoteAddress: input.remoteAddress, forwardedFor: input.forwardedFor })
      : normalizeObservedAddress(input.remoteAddress);
  return ip ? `ip:${ip}` : 'unknown';
}

/**
 * Server-derived rate-limit identity.
 *
 * Authenticated: validated session tenant + principal only.
 * Local (auth not wired): the host bootstrap identity is the only identity.
 * Unauthenticated: anonymous or pre-auth bootstrap, keyed by the observed
 * socket address — never `options.tenantId` / `options.principalId`, never a
 * client-supplied tenant/principal. `/api/auth/login` is the exception: when
 * the socket peer is a trusted proxy, identity uses a sanitized forwarded hop.
 */
export function resolveRateLimitIdentity(input: {
  actor: { tenantId: string; principalId: string; sessionId: string | null } | null;
  authWired: boolean;
  pathname: string;
  remoteAddress?: string;
  forwardedFor?: string;
}): RateLimitIdentity {
  const tenant = input.actor?.tenantId?.trim() ?? '';
  const principal = input.actor?.principalId?.trim() ?? '';
  const sessionId = input.actor?.sessionId?.trim() ?? '';
  if (input.authWired && sessionId && tenant && principal) {
    return { kind: 'authenticated', tenantId: tenant, actorId: principal };
  }
  if (!input.authWired && tenant && principal) {
    return { kind: 'local', tenantId: tenant, actorId: principal };
  }
  const host = observedHost(input);
  const bootstrap =
    input.pathname === '/api/session' ||
    input.pathname.startsWith('/api/session/') ||
    input.pathname === '/api/auth/login';
  return {
    kind: bootstrap ? 'bootstrap' : 'anonymous',
    tenantId: ANONYMOUS_RATE_TENANT,
    actorId: `${bootstrap ? 'bootstrap' : 'anon'}:${host}`,
  };
}

/**
 * Cheap admission identity used BEFORE session resolution.
 *
 * Cookie presence is a local parse of the Cookie header — the session is not
 * loaded. Unique forged cookies from one socket still share one `*:cookie`
 * bucket so they cannot flood session storage. Forwarding headers are never
 * consulted except on `/api/auth/login` behind a trusted proxy peer.
 */
export function resolveAdmissionIdentity(input: {
  pathname: string;
  remoteAddress?: string;
  forwardedFor?: string;
  cookiePresent: boolean;
}): RateLimitIdentity {
  const host = observedHost(input);
  const bootstrap =
    input.pathname === '/api/session' ||
    input.pathname.startsWith('/api/session/') ||
    input.pathname === '/api/auth/login';
  if (bootstrap) {
    return {
      kind: 'bootstrap',
      tenantId: ANONYMOUS_RATE_TENANT,
      actorId: `bootstrap:${host}`,
    };
  }
  return {
    kind: 'anonymous',
    tenantId: ANONYMOUS_RATE_TENANT,
    actorId: input.cookiePresent ? `anon:${host}:cookie` : `anon:${host}`,
  };
}

export function sameRateLimitIdentity(a: RateLimitIdentity, b: RateLimitIdentity): boolean {
  return a.kind === b.kind && a.tenantId === b.tenantId && a.actorId === b.actorId;
}

/**
 * Platform-owned limiter. Keys are server-derived tenant + actor ids, never a
 * client-supplied tenant header. Unauthenticated callers use a reserved
 * anonymous tenant plus the observed socket address. Per-process:
 * multi-instance deployments get N× the configured ceiling unless a shared
 * limiter is added later.
 *
 * Bucket cardinality is bounded. Expired entries are reclaimed without the
 * original key being reused, and opportunistic cleanup inspects a fixed batch
 * so rotating anonymous identities cannot amplify CPU.
 */
export class PlatformRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();
  private readonly maxBuckets: number;
  private readonly sweepBatch: number;
  private readonly sweepIntervalMs: number;
  private lastSweepAt = 0;
  private sweepCursor: string | undefined;

  constructor(
    private readonly config: RateLimitConfig = DEFAULT_RATE_LIMITS,
    private readonly now: () => number = Date.now,
    bounds: RateLimiterBounds = {},
  ) {
    this.maxBuckets = Math.max(1, Math.floor(bounds.maxBuckets ?? DEFAULT_RATE_LIMIT_MAX_BUCKETS));
    this.sweepBatch = Math.max(1, Math.floor(bounds.sweepBatch ?? DEFAULT_RATE_LIMIT_SWEEP_BATCH));
    this.sweepIntervalMs = Math.max(0, Math.floor(bounds.sweepIntervalMs ?? DEFAULT_RATE_LIMIT_SWEEP_INTERVAL_MS));
  }

  hit(rateClass: RateClass, tenantId: string, actorId: string): void {
    const tenant = tenantId.trim();
    const actor = actorId.trim();
    if (!tenant || !actor) {
      throw new PlatformHttpError('unauthenticated', 'Authentication required.', 401);
    }
    const limit = this.config.limits[rateClass];
    const key = `${rateClass}:${tenant}:${actor}`;
    const now = this.now();
    this.sweepExpired(now, false);
    let row = this.buckets.get(key);
    if (!row || row.resetAt <= now) {
      if (row) this.buckets.delete(key);
      this.ensureCapacity(now, tenant, key);
      row = { count: 0, resetAt: now + this.config.windowMs, touchedAt: now, tenantId: tenant };
      this.buckets.set(key, row);
    }
    row.count += 1;
    row.touchedAt = now;
    if (row.count > limit) {
      platformMetrics.inc('atlas_rate_limited_total', { route_class: rateClass, outcome: 'rejected' });
      logPlatform('rate.limited', { routeClass: rateClass, tenantId: tenant, actorId: actor }, 'warn');
      throw new PlatformHttpError('rate_limit', 'Rate limit exceeded.', 429, true);
    }
  }

  size(): number {
    return this.buckets.size;
  }

  private sweepExpired(now: number, force: boolean): void {
    if (this.buckets.size === 0) return;
    if (!force && now - this.lastSweepAt < this.sweepIntervalMs) return;
    const elapsed = now - this.lastSweepAt;
    this.lastSweepAt = now;
    const budget =
      force || elapsed >= this.config.windowMs
        ? Math.min(this.buckets.size, this.maxBuckets)
        : Math.min(this.sweepBatch, this.buckets.size);
    const keys = [...this.buckets.keys()];
    if (keys.length === 0) return;
    let start = 0;
    if (this.sweepCursor) {
      const idx = keys.indexOf(this.sweepCursor);
      start = idx >= 0 ? idx : 0;
    }
    let scanned = 0;
    let index = start;
    while (scanned < budget && scanned < keys.length) {
      const key = keys[index]!;
      const row = this.buckets.get(key);
      if (row && row.resetAt <= now) this.buckets.delete(key);
      scanned += 1;
      index = (index + 1) % keys.length;
      if (index === start) break;
    }
    this.sweepCursor = keys[index] ?? keys[0];
  }

  private ensureCapacity(now: number, tenantId: string, incomingKey: string): void {
    if (this.buckets.size < this.maxBuckets) return;
    this.sweepExpired(now, true);
    if (this.buckets.size < this.maxBuckets) return;
    const evicted = this.evictBounded(now, tenantId, incomingKey);
    if (evicted) return;
    throw new PlatformHttpError('rate_limit', 'Rate limit exceeded.', 429, true);
  }

  private evictBounded(now: number, tenantId: string, incomingKey: string): boolean {
    const anonymousIncoming = tenantId === ANONYMOUS_RATE_TENANT;
    let victim: { key: string; touchedAt: number } | undefined;
    let scanned = 0;
    for (const [key, row] of this.buckets) {
      if (scanned >= this.maxBuckets) break;
      scanned += 1;
      if (key === incomingKey) continue;
      if (row.resetAt <= now) {
        this.buckets.delete(key);
        return true;
      }
      const anonymousRow = row.tenantId === ANONYMOUS_RATE_TENANT;
      if (anonymousIncoming && !anonymousRow) continue;
      if (!victim || row.touchedAt < victim.touchedAt) {
        victim = { key, touchedAt: row.touchedAt };
      }
    }
    if (!victim) return false;
    this.buckets.delete(victim.key);
    return true;
  }
}

export function normalizeContextFileIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
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

  occupancy(tenantId: string): { streams: number; runs: number } {
    const key = tenantId.trim() || 'unknown';
    return { streams: this.streams.get(key) ?? 0, runs: this.runs.get(key) ?? 0 };
  }

  generatedByteLimit(): number {
    return this.limits.maxGeneratedBytes;
  }

  assertGeneratedOutput(bytes: number): void {
    this.assertBodySize(bytes, 'generated');
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
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = map.get(key) ?? 1;
      if (current <= 1) map.delete(key);
      else map.set(key, current - 1);
    };
  }
}

export function rateClassForPath(pathname: string, method = 'GET'): RateClass | null {
  if (pathname.startsWith('/api/health') || pathname.startsWith('/api/metrics')) return null;
  if (pathname.startsWith('/api/ops/')) return 'tools';
  if (pathname.startsWith('/api/session') || pathname === '/api/auth/login') return 'auth';
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
