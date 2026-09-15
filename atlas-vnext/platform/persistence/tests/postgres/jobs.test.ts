import { afterEach, describe, expect, it } from 'vitest';
import { openPostgresPersistence } from '../../src/postgres/kernel.ts';
import { dropTestSchema, openPairedKernels, openTestKernel, persistenceConfig, tenantA, tenantB } from './harness.ts';

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
      await dropTestSchema(schema);
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

  it('records job attempts and keeps waiting_runtime across a fresh kernel', async () => {
    const handle = await openTestKernel();
    const { schema, kernel } = handle;
    await kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const jobs = kernel.forActor(tenantA).jobs;
    const job = await jobs.enqueue(tenantA, { dungeon: 'writing', type: 'gpu', maxRetries: 2 });
    await jobs.claimNext(tenantA, 'w1', 30_000);
    const attempts = await jobs.listAttempts(tenantA, job.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('started');
    await jobs.waitForRuntime(tenantA, job.id);
    await kernel.close();

    const reopened = await openPostgresPersistence(persistenceConfig(schema));
    cleanups.push(async () => {
      await reopened.close();
      await dropTestSchema(schema);
    });
    const recovered = await reopened.recoverOnStart();
    expect(recovered.jobs.some((item) => item.id === job.id)).toBe(false);
    const loaded = await reopened.forActor(tenantA).jobs.get(tenantA, job.id);
    expect(loaded?.status).toBe('waiting_runtime');
    expect(await reopened.forActor(tenantA).jobs.claimNext(tenantA, 'w2', 10_000)).toBeNull();
  });

  it('rejects a thief heartbeat while the owner refreshes the lease', async () => {
    const pair = await openPairedKernels();
    cleanups.push(pair.close);
    await pair.a.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    await pair.a.forActor(tenantA).jobs.enqueue(tenantA, { dungeon: 'osint', type: 'scan' });
    const claimed = await pair.a.forActor(tenantA).jobs.claimNext(tenantA, 'owner', 30_000);
    expect(claimed).toBeTruthy();
    const results = await Promise.allSettled([
      pair.a.forActor(tenantA).jobs.heartbeat(tenantA, claimed!.id, 'owner', 30_000),
      pair.b.forActor(tenantA).jobs.heartbeat(tenantA, claimed!.id, 'thief', 30_000),
    ]);
    const fulfilled = results.filter((item) => item.status === 'fulfilled');
    const rejected = results.filter((item) => item.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it('retries complete and checkpoint via database constraints, not process memory', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const jobs = handle.kernel.forActor(tenantA).jobs;
    const job = await jobs.enqueue(tenantA, { dungeon: 'writing', type: 'commission' });
    await jobs.claimNext(tenantA, 'w1', 30_000);
    const first = await jobs.checkpoint(tenantA, job.id, 'draft', 0.5, { page: 1 }, 'cp-1');
    const retry = await jobs.checkpoint(tenantA, job.id, 'draft', 0.9, { page: 9 }, 'cp-1');
    expect(retry.checkpoint).toEqual(first.checkpoint);
    const rows = await handle.kernel.tx.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM job_checkpoints WHERE job_id = $1',
      [job.id],
    );
    expect(rows.rows[0]?.n).toBe(1);
    await jobs.complete(tenantA, job.id);
    const again = await jobs.complete(tenantA, job.id);
    expect(again.status).toBe('completed');
    const events = await handle.kernel.forActor(tenantA).events.history(`job:${job.id}`);
    expect(events.filter((event) => event.type === 'job.completed')).toHaveLength(1);
  });

  it('treats a retried enqueue after an uncertain result as the same job', async () => {
    const pair = await openPairedKernels();
    cleanups.push(pair.close);
    await pair.a.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const [one, two] = await Promise.all([
      pair.a.forActor(tenantA).jobs.enqueue(tenantA, { dungeon: 'writing', type: 'commission', idempotencyKey: 'api-1' }),
      pair.b.forActor(tenantA).jobs.enqueue(tenantA, { dungeon: 'writing', type: 'commission', idempotencyKey: 'api-1' }),
    ]);
    expect(one.id).toBe(two.id);
    const count = await pair.a.tx.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM jobs');
    expect(count.rows[0]?.n).toBe(1);
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
