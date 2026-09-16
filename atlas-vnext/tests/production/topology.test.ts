import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileRuntimeStateStore, emptyRuntime } from '@atlas-vnext/execution';
import { PlatformRateLimiter } from '../../apps/host/src/limits.ts';
import { PlatformHttpError } from '../../apps/host/src/errors.ts';
import { SINGLE_INSTANCE_TOPOLOGY } from '../../apps/host/src/production-config.ts';

describe('single-instance topology is not horizontal HA', () => {
  it('exposes an honest in-process contract', () => {
    expect(SINGLE_INSTANCE_TOPOLOGY.ha).toBe(false);
    expect(SINGLE_INSTANCE_TOPOLOGY.rateLimiterScope).toBe('in-process');
    expect(SINGLE_INSTANCE_TOPOLOGY.sseFanout).toBe('in-process');
    expect(SINGLE_INSTANCE_TOPOLOGY.runpodScheduler).toBe('local-file');
    expect(SINGLE_INSTANCE_TOPOLOGY.tracingExporter).toBe('none');
  });

  it('does not share rate-limit buckets across limiter instances', () => {
    const config = {
      windowMs: 60_000,
      limits: {
        auth: 1,
        runs: 10,
        generation: 10,
        upload: 10,
        retrieval: 10,
        tools: 10,
        approvals: 10,
        documents: 10,
      },
    };
    const now = () => 1;
    const a = new PlatformRateLimiter(config, now);
    const b = new PlatformRateLimiter(config, now);
    a.hit('auth', 'tenant_a', 'user_a');
    expect(() => a.hit('auth', 'tenant_a', 'user_a')).toThrow(PlatformHttpError);
    expect(() => b.hit('auth', 'tenant_a', 'user_a')).not.toThrow();
  });

  it('treats RunPod runtime.json as last-write-wins without fencing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-runpod-store-'));
    const path = join(dir, 'runtime.json');
    const a = new FileRuntimeStateStore(path);
    const b = new FileRuntimeStateStore(path);
    await a.save({ ...emptyRuntime('2026-09-15T00:00:00.000Z'), stopReason: 'writer-a' });
    await b.save({ ...emptyRuntime('2026-09-15T00:00:01.000Z'), stopReason: 'writer-b' });
    expect((await a.load())?.stopReason).toBe('writer-b');
  });
});
