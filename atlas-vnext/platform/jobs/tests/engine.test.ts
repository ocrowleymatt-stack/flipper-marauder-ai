import { describe, expect, it } from 'vitest';
import { createJobEngine, MemoryJobStore } from '../src/index.ts';

const actor = { tenantId: 'tenant_a' };

describe('durable job engine (memory contracts)', () => {
  it('enqueues idempotently and checkpoints across the state machine', async () => {
    const engine = createJobEngine({ store: new MemoryJobStore() });
    const first = await engine.enqueue(actor, {
      dungeon: 'writing',
      type: 'commission',
      idempotencyKey: 'k1',
    });
    const second = await engine.enqueue(actor, {
      dungeon: 'writing',
      type: 'commission',
      idempotencyKey: 'k1',
    });
    expect(second.id).toBe(first.id);
    const claimed = await engine.claimNext(actor, 'worker-1', 5_000);
    expect(claimed?.id).toBe(first.id);
    const check = await engine.checkpoint(actor, first.id, 'draft', 0.4, { chapter: 1 });
    expect(check.checkpoint).toEqual({ chapter: 1 });
    const done = await engine.complete(actor, first.id);
    expect(done.status).toBe('completed');
    await expect(engine.checkpoint(actor, first.id, 'x', 1, {})).rejects.toThrow(/cannot checkpoint/);
  });

  it('keeps waiting_runtime jobs out of the claim queue', async () => {
    const engine = createJobEngine({ store: new MemoryJobStore() });
    const job = await engine.enqueue(actor, { dungeon: 'research', type: 'scan' });
    await engine.waitForRuntime(actor, job.id);
    const claimed = await engine.claimNext(actor, 'worker-1', 5_000);
    expect(claimed).toBeNull();
    const still = await engine.get(actor, job.id);
    expect(still?.status).toBe('waiting_runtime');
  });
});
