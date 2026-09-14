import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { openPostgresPersistence } from '../../src/postgres/kernel.ts';
import { assertIdent } from '../../src/postgres/tx.ts';
import { openPairedKernels, openTestKernel, persistenceConfig, postgresUrl, tenantA, tenantB } from './harness.ts';

const { Pool } = pg;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe('durable jobs', () => {
  it('keeps queued jobs across restart and restores checkpoints', async () => {
    const handle = await openTestKernel();
    const { schema, kernel } = handle;
    await kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const jobs = kernel.forActor(tenantA).jobs;
    const job = await jobs.enqueue(tenantA, { dungeon: 'writing', type: 'commission', maxRetries: 2 });
    await jobs.claimNext(tenantA, 'w1', 60_000);
    await jobs.checkpoint(tenantA, job.id, 'draft', 0.5, { page: 2 });
    await kernel.close();

    const reopened = await openPostgresPersistence(persistenceConfig(schema));
    cleanups.push(async () => {
      await reopened.close();
      const cleanup = new Pool({ connectionString: postgresUrl() });
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS ${assertIdent(schema)} CASCADE`);
      } finally {
        await cleanup.end();
      }
    });
    const loaded = await reopened.forActor(tenantA).jobs.get(tenantA, job.id);
    expect(loaded?.checkpoint).toEqual({ page: 2 });
    expect(loaded?.currentStage).toBe('draft');
    expect(loaded?.status).toBe('running');
  });

  it('recovers expired running leases without touching waiting_runtime', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const jobs = handle.kernel.forActor(tenantA).jobs;
    const running = await jobs.enqueue(tenantA, { dungeon: 'writing', type: 'run', maxRetries: 1 });
    await jobs.claimNext(tenantA, 'dead-worker', 1);
    await jobs.heartbeat(tenantA, running.id, 'dead-worker', -1_000);
    const waiting = await jobs.enqueue(tenantA, { dungeon: 'writing', type: 'gpu' });
    await jobs.waitForRuntime(tenantA, waiting.id);
    const recovered = await jobs.recoverExpiredLeases(new Date().toISOString());
    expect(recovered.some((job) => job.id === running.id)).toBe(true);
    expect(recovered.some((job) => job.id === waiting.id)).toBe(false);
    expect((await jobs.get(tenantA, running.id))?.status).toBe('queued');
    expect((await jobs.get(tenantA, waiting.id))?.status).toBe('waiting_runtime');
  });

  it('allows only one of two competing workers to claim a job', async () => {
    const pair = await openPairedKernels();
    cleanups.push(pair.close);
    await pair.a.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    await pair.a.forActor(tenantA).jobs.enqueue(tenantA, { dungeon: 'osint', type: 'scan' });
    const [one, two] = await Promise.all([
      pair.a.forActor(tenantA).jobs.claimNext(tenantA, 'worker-a', 30_000),
      pair.b.forActor(tenantA).jobs.claimNext(tenantA, 'worker-b', 30_000),
    ]);
    const ids = [one?.id, two?.id].filter(Boolean);
    expect(ids).toHaveLength(1);
    expect(Boolean(one) !== Boolean(two)).toBe(true);
  });

  it('persists cancellation and refuses tenant B mutation', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    await handle.kernel.ensureTenant({ id: tenantB.tenantId, name: 'B' });
    const jobs = handle.kernel.forActor(tenantA).jobs;
    const job = await jobs.enqueue(tenantA, { dungeon: 'writing', type: 'commission' });
    const cancelled = await jobs.cancel(tenantA, job.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelRequested).toBe(true);
    await expect(handle.kernel.forActor(tenantB).jobs.cancel(tenantB, job.id)).rejects.toThrow(/not visible/);
    const claimed = await jobs.claimNext(tenantA, 'w1', 10_000);
    expect(claimed).toBeNull();
  });
});
