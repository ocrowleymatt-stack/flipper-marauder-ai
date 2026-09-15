import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ANONYMOUS_RATE_TENANT,
  PlatformRateLimiter,
  normalizeObservedAddress,
  resolveRateLimitIdentity,
} from '../../apps/host/src/limits.ts';
import { PlatformHttpError } from '../../apps/host/src/errors.ts';
import { authHeaders, bootstrap, startProductionHost } from './harness.ts';

const servers: Server[] = [];
const spines: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
  await Promise.all(spines.splice(0).map((spine) => spine.close().catch(() => undefined)));
});

function tightLimiter(runs = 3, auth = 8): PlatformRateLimiter {
  return new PlatformRateLimiter({
    windowMs: 60_000,
    limits: {
      auth,
      runs,
      generation: 8,
      upload: 8,
      retrieval: 8,
      tools: 8,
      approvals: 8,
      documents: 8,
    },
  });
}

const poisonHeaders = {
  'x-atlas-tenant-id': 'tenant_a',
  'x-tenant-id': 'tenant_a',
  'x-atlas-principal-id': 'principal_tenant_a',
  'x-principal-id': 'principal_tenant_a',
  'x-forwarded-for': '203.0.113.9',
  'x-real-ip': '198.51.100.4',
  forwarded: 'for=203.0.113.9',
};

describe('rate-limit identity semantics', () => {
  it('keys authenticated traffic on the validated session tenant/principal only', () => {
    const identity = resolveRateLimitIdentity({
      actor: { tenantId: 'tenant_a', principalId: 'principal_a', sessionId: 'ses_1' },
      authWired: true,
      pathname: '/api/conversations',
      remoteAddress: '203.0.113.1',
    });
    expect(identity).toEqual({
      kind: 'authenticated',
      tenantId: 'tenant_a',
      actorId: 'principal_a',
    });
  });

  it('does not manufacture host identity for session-less traffic when auth is wired', () => {
    const anonymous = resolveRateLimitIdentity({
      actor: null,
      authWired: true,
      pathname: '/api/conversations',
      remoteAddress: '127.0.0.1',
    });
    expect(anonymous.kind).toBe('anonymous');
    expect(anonymous.tenantId).toBe(ANONYMOUS_RATE_TENANT);
    expect(anonymous.actorId).toBe('anon:ip:127.0.0.1');
    expect(anonymous.tenantId).not.toBe('tenant_a');
    expect(anonymous.actorId).not.toBe('principal_a');

    const manufactured = resolveRateLimitIdentity({
      actor: { tenantId: 'tenant_a', principalId: 'principal_a', sessionId: null },
      authWired: true,
      pathname: '/api/conversations',
      remoteAddress: '127.0.0.1',
    });
    expect(manufactured).toEqual(anonymous);
  });

  it('keys public bootstrap endpoints separately from other anonymous traffic', () => {
    const bootstrap = resolveRateLimitIdentity({
      actor: null,
      authWired: true,
      pathname: '/api/session',
      remoteAddress: '127.0.0.1',
    });
    const anonymous = resolveRateLimitIdentity({
      actor: null,
      authWired: true,
      pathname: '/api/conversations',
      remoteAddress: '127.0.0.1',
    });
    expect(bootstrap.kind).toBe('bootstrap');
    expect(bootstrap.tenantId).toBe(ANONYMOUS_RATE_TENANT);
    expect(bootstrap.actorId).toBe('bootstrap:ip:127.0.0.1');
    expect(anonymous.actorId).not.toBe(bootstrap.actorId);
  });

  it('keys distinct anonymous callers by observed socket address, not one shared bucket', () => {
    const a = resolveRateLimitIdentity({
      actor: null,
      authWired: true,
      pathname: '/api/conversations',
      remoteAddress: '192.0.2.10',
    });
    const b = resolveRateLimitIdentity({
      actor: null,
      authWired: true,
      pathname: '/api/conversations',
      remoteAddress: '192.0.2.11',
    });
    expect(a.actorId).toBe('anon:ip:192.0.2.10');
    expect(b.actorId).toBe('anon:ip:192.0.2.11');
    expect(a.actorId).not.toBe(b.actorId);
    expect(normalizeObservedAddress('::ffff:192.0.2.10')).toBe('192.0.2.10');
  });

  it('keeps local no-auth hosts on the host identity and still isolates principals on the limiter', () => {
    const local = resolveRateLimitIdentity({
      actor: { tenantId: 'tenant_local', principalId: 'principal_local', sessionId: null },
      authWired: false,
      pathname: '/api/conversations',
      remoteAddress: '127.0.0.1',
    });
    expect(local).toEqual({
      kind: 'local',
      tenantId: 'tenant_local',
      actorId: 'principal_local',
    });
    const limiter = new PlatformRateLimiter(
      {
        windowMs: 60_000,
        limits: {
          auth: 1,
          runs: 1,
          generation: 1,
          upload: 1,
          retrieval: 1,
          tools: 1,
          approvals: 1,
          documents: 1,
        },
      },
      () => 1,
    );
    limiter.hit('runs', 'tenant_a', 'principal_a');
    expect(() => limiter.hit('runs', 'tenant_a', 'principal_a')).toThrow(PlatformHttpError);
    expect(() => limiter.hit('runs', 'tenant_a', 'principal_b')).not.toThrow();
    expect(() => limiter.hit('runs', ANONYMOUS_RATE_TENANT, 'anon:ip:127.0.0.1')).not.toThrow();
  });
});

describe('unauthenticated rate-limit buckets cannot contaminate authenticated quotas', () => {
  it('rejects abusive anonymous traffic without exhausting the host session', async () => {
    const limiter = tightLimiter(3, 8);
    const started = await startProductionHost({ rateLimiter: limiter });
    servers.push(started.server);
    spines.push(started.spine);

    const unauthStatuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await fetch(`${started.url}/api/conversations`);
      unauthStatuses.push(response.status);
      await response.text();
    }
    expect(unauthStatuses).toEqual([401, 401, 401]);

    const exhausted = await fetch(`${started.url}/api/conversations`);
    expect(exhausted.status).toBe(429);
    const exhaustedBody = (await exhausted.json()) as { code: string };
    expect(exhaustedBody.code).toBe('rate_limit');

    const poisoned = await fetch(
      `${started.url}/api/conversations?tenantId=tenant_a&principalId=${started.spine.principalId}`,
      { headers: poisonHeaders },
    );
    expect(poisoned.status).toBe(429);

    const session = await bootstrap(started.url);
    const allowed = await fetch(`${started.url}/api/conversations`, { headers: authHeaders(session) });
    expect(allowed.status).toBe(200);
    expect(Array.isArray(await allowed.json())).toBe(true);

    const stillAllowed = await fetch(`${started.url}/api/conversations`, {
      headers: authHeaders(session, poisonHeaders),
    });
    expect(stillAllowed.status).toBe(200);
  });

  it('keeps authenticated principals isolated and ignores client-supplied identity on anonymous calls', async () => {
    const limiter = tightLimiter(2, 8);
    const started = await startProductionHost({ rateLimiter: limiter });
    servers.push(started.server);
    spines.push(started.spine);
    const session = await bootstrap(started.url);

    const first = await fetch(`${started.url}/api/conversations`, { headers: authHeaders(session) });
    const second = await fetch(`${started.url}/api/conversations`, { headers: authHeaders(session) });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const overflow = await fetch(`${started.url}/api/conversations`, { headers: authHeaders(session) });
    expect(overflow.status).toBe(429);

    const unauth = await fetch(`${started.url}/api/conversations`, { headers: poisonHeaders });
    expect(unauth.status).toBe(401);

    const other = await startProductionHost({ tenantId: 'tenant_b', rateLimiter: tightLimiter(2, 8) });
    servers.push(other.server);
    spines.push(other.spine);
    const otherSession = await bootstrap(other.url);
    const otherOk = await fetch(`${other.url}/api/conversations`, { headers: authHeaders(otherSession) });
    expect(otherOk.status).toBe(200);
  });

  it('rate-limits anonymous bootstrap POSTs without starving a later authenticated host session', async () => {
    const limiter = tightLimiter(8, 3);
    const started = await startProductionHost({ rateLimiter: limiter });
    servers.push(started.server);
    spines.push(started.spine);

    const issued: Array<{ cookie: string; csrf: string }> = [];
    for (let i = 0; i < 3; i += 1) {
      issued.push(await bootstrap(started.url));
    }
    const blocked = await fetch(`${started.url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...poisonHeaders },
      body: JSON.stringify({ tenantId: started.spine.tenantId, principalId: started.spine.principalId }),
    });
    expect(blocked.status).toBe(429);

    const authed = await fetch(`${started.url}/api/conversations`, { headers: authHeaders(issued[0]!) });
    expect(authed.status).toBe(200);
  });
});

describe('rate-limit bucket cardinality is bounded', () => {
  function clockedLimiter(maxBuckets: number) {
    let now = 1_000;
    const limiter = new PlatformRateLimiter(
      {
        windowMs: 60_000,
        limits: {
          auth: 30,
          runs: 8,
          generation: 8,
          upload: 8,
          retrieval: 8,
          tools: 8,
          approvals: 8,
          documents: 8,
        },
      },
      () => now,
      { maxBuckets, sweepBatch: 16, sweepIntervalMs: 0 },
    );
    return {
      limiter,
      advance(ms: number) {
        now += ms;
      },
    };
  }

  it('does not retain unbounded state for thousands of rotating anonymous identities', () => {
    const { limiter } = clockedLimiter(64);
    for (let i = 0; i < 4_000; i += 1) {
      limiter.hit('runs', ANONYMOUS_RATE_TENANT, `anon:ip:203.0.113.${i}`);
    }
    expect(limiter.size()).toBeLessThanOrEqual(64);
  });

  it('reclaims expired buckets without requiring the original key to be reused', () => {
    const { limiter, advance } = clockedLimiter(1_000);
    for (let i = 0; i < 40; i += 1) {
      limiter.hit('runs', ANONYMOUS_RATE_TENANT, `anon:ip:198.51.100.${i}`);
    }
    expect(limiter.size()).toBe(40);
    advance(70_000);
    limiter.hit('runs', ANONYMOUS_RATE_TENANT, 'anon:ip:198.51.100.99');
    expect(limiter.size()).toBe(1);
  });

  it('enforces a hard cardinality ceiling', () => {
    const { limiter } = clockedLimiter(8);
    for (let i = 0; i < 50; i += 1) {
      limiter.hit('auth', ANONYMOUS_RATE_TENANT, `bootstrap:ip:192.0.2.${i}`);
    }
    expect(limiter.size()).toBeLessThanOrEqual(8);
  });

  it('keeps authenticated quota isolated from anonymous churn', () => {
    const { limiter } = clockedLimiter(16);
    limiter.hit('runs', 'tenant_a', 'principal_a');
    limiter.hit('runs', 'tenant_a', 'principal_a');
    for (let i = 0; i < 200; i += 1) {
      limiter.hit('runs', ANONYMOUS_RATE_TENANT, `anon:ip:203.0.113.${i}`);
    }
    for (let i = 0; i < 6; i += 1) {
      expect(() => limiter.hit('runs', 'tenant_a', 'principal_a')).not.toThrow();
    }
    expect(() => limiter.hit('runs', 'tenant_a', 'principal_a')).toThrow(PlatformHttpError);
  });

  it('still rate-limits repeated requests from one anonymous identity', () => {
    const { limiter } = clockedLimiter(32);
    const actor = 'anon:ip:192.0.2.10';
    for (let i = 0; i < 8; i += 1) {
      limiter.hit('runs', ANONYMOUS_RATE_TENANT, actor);
    }
    expect(() => limiter.hit('runs', ANONYMOUS_RATE_TENANT, actor)).toThrow(PlatformHttpError);
  });

  it('does not let spoofed client identity poison another principal quota', async () => {
    const limiter = tightLimiter(3, 8);
    const started = await startProductionHost({ rateLimiter: limiter });
    servers.push(started.server);
    spines.push(started.spine);
    const session = await bootstrap(started.url);
    for (let i = 0; i < 20; i += 1) {
      const response = await fetch(`${started.url}/api/conversations`, {
        headers: {
          ...poisonHeaders,
          'x-forwarded-for': `198.51.100.${i}`,
        },
      });
      expect([401, 429]).toContain(response.status);
      await response.text();
    }
    const allowed = await fetch(`${started.url}/api/conversations`, { headers: authHeaders(session) });
    expect(allowed.status).toBe(200);
  });
});
