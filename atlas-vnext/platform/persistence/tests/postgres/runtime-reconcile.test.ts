import { afterEach, describe, expect, it } from 'vitest';
import { openPostgresPersistence } from '../../src/postgres/kernel.ts';
import { dropTestSchema, openTestKernel, persistenceConfig, tenantA } from './harness.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe('runtime reconciliation persistence', () => {
  it('keeps waiting_runtime and a single runtime lease after a fresh process starts', async () => {
    const handle = await openTestKernel();
    const { schema, kernel } = handle;
    await kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const jobs = kernel.forActor(tenantA).jobs;
    const job = await jobs.enqueue(tenantA, { dungeon: 'writing', type: 'gpu' });
    await jobs.waitForRuntime(tenantA, job.id);
    const lease = await kernel.runtimeLeases.upsert(tenantA, {
      id: 'rle_pod_shared',
      resourceKey: 'runpod:pod-shared',
      owner: 'scheduler',
      leaseUntil: '2099-01-01T00:00:00.000Z',
      status: 'held',
      metadata: { podId: 'pod-shared', maxActivePods: 1 },
    });
    await kernel.close();

    const reopened = await openPostgresPersistence(persistenceConfig(schema));
    cleanups.push(async () => {
      await reopened.close();
      await dropTestSchema(schema);
    });
    const recovery = await reopened.recoverOnStart();
    expect(recovery.runtimeLeases).toEqual([]);
    const waiting = await reopened.forActor(tenantA).jobs.get(tenantA, job.id);
    expect(waiting?.status).toBe('waiting_runtime');
    const still = await reopened.runtimeLeases.get(tenantA, 'runpod:pod-shared');
    expect(still?.id).toBe(lease.id);
    expect(still?.metadata).toEqual({ podId: 'pod-shared', maxActivePods: 1 });
    const leases = await reopened.tx.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM runtime_leases WHERE resource_key = $1',
      ['runpod:pod-shared'],
    );
    expect(leases.rows[0]?.n).toBe(1);
  });
});
