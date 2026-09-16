import { describe, expect, it } from 'vitest';
import { composeSpine } from '../../apps/host/src/index.ts';
import { memoryConfig } from './harness.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformRateLimiter } from '../../apps/host/src/limits.ts';
import { PlatformHttpError } from '../../apps/host/src/errors.ts';

describe('performance baseline (ex-model)', () => {
  it('starts a mock host and serves health within a non-pathological budget', async () => {
    const t0 = Date.now();
    const dir = mkdtempSync(join(tmpdir(), 'atlas-perf-'));
    const spine = await composeSpine({
      dataPath: join(dir, 'state.json'),
      mode: 'mock',
      persistence: memoryConfig('tenant_a'),
      casRoot: join(dir, 'cas'),
    });
    const startupMs = Date.now() - t0;
    expect(startupMs).toBeLessThan(15_000);
    await spine.close();
  });
});

describe('platform rate limiter', () => {
  it('keys on server tenant/actor and rejects after the ceiling', () => {
    const limiter = new PlatformRateLimiter(
      { windowMs: 60_000, limits: { auth: 2, runs: 10, generation: 10, upload: 10, retrieval: 10, tools: 10, approvals: 10, documents: 10 } },
      () => 1,
    );
    limiter.hit('auth', 'tenant_a', 'user_a');
    limiter.hit('auth', 'tenant_a', 'user_a');
    expect(() => limiter.hit('auth', 'tenant_a', 'user_a')).toThrow(PlatformHttpError);
    limiter.hit('auth', 'tenant_b', 'user_a');
  });
});
