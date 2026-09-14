import { afterEach, describe, expect, it } from 'vitest';
import { openPairedKernels, openTestKernel, tenantA, tenantB } from './harness.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe('durable event stream', () => {
  it('appends with monotonic seq, replays from a cursor, and is idempotent', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const events = handle.kernel.forActor(tenantA).events;
    const first = await events.publish({ channel: 'conversation:cnv_1', type: 'message.appended', payload: { n: 1 } });
    const second = await events.publish({ channel: 'conversation:cnv_1', type: 'execution.created', payload: { n: 2 } });
    const third = await events.publish({
      channel: 'conversation:cnv_1',
      type: 'execution.completed',
      payload: { n: 3 },
      idempotencyKey: 'turn-1-complete',
    });
    const replayed = await events.publish({
      channel: 'conversation:cnv_1',
      type: 'execution.completed',
      payload: { n: 99 },
      idempotencyKey: 'turn-1-complete',
    });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(third.seq).toBe(3);
    expect(replayed.eventId).toBe(third.eventId);
    expect(replayed.seq).toBe(3);
    const afterFirst = await events.replay('conversation:cnv_1', { eventId: first.eventId });
    expect(afterFirst.map((event) => event.type)).toEqual(['execution.created', 'execution.completed']);
    const afterSeq = await events.replay('conversation:cnv_1', { seq: 2 });
    expect(afterSeq).toHaveLength(1);
    expect(afterSeq[0]?.type).toBe('execution.completed');
  });

  it('does not leak tenant B events on replay', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    await handle.kernel.ensureTenant({ id: tenantB.tenantId, name: 'B' });
    await handle.kernel.forActor(tenantA).events.publish({
      channel: 'job:shared-name',
      type: 'job.created',
      payload: { secret: 'a' },
    });
    await handle.kernel.forActor(tenantB).events.publish({
      channel: 'job:other',
      type: 'job.created',
      payload: { secret: 'b' },
    });
    const replayA = await handle.kernel.forActor(tenantA).events.replay('*');
    expect(replayA.every((event) => event.tenantId === tenantA.tenantId)).toBe(true);
    expect(replayA.some((event) => event.tenantId === tenantB.tenantId)).toBe(false);
  });

  it('exposes a bounded retention hook', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const events = handle.kernel.forActor(tenantA).events;
    for (let i = 0; i < 5; i += 1) {
      await events.publish({ channel: 'stream:x', type: 'tick', payload: { i } });
    }
    const removed = await handle.kernel.applyEventRetention(2);
    expect(removed).toBe(3);
    const remaining = await events.history('stream:x');
    expect(remaining).toHaveLength(2);
    expect(remaining.map((event) => (event.payload as { i: number }).i)).toEqual([3, 4]);
  });

  it('assigns unique seq when two kernels append at once and isolates the same channel name', async () => {
    const pair = await openPairedKernels();
    cleanups.push(pair.close);
    await pair.a.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    await pair.a.ensureTenant({ id: tenantB.tenantId, name: 'B' });
    const [one, two] = await Promise.all([
      pair.a.forActor(tenantA).events.publish({ channel: 'stream:shared', type: 'tick', payload: { n: 1 } }),
      pair.b.forActor(tenantA).events.publish({ channel: 'stream:shared', type: 'tick', payload: { n: 2 } }),
    ]);
    expect(new Set([one.seq, two.seq]).size).toBe(2);
    const replay = await pair.a.forActor(tenantA).events.history('stream:shared');
    expect(replay.map((event) => event.seq).sort((a, b) => a - b)).toEqual([1, 2]);

    await pair.a.forActor(tenantB).events.publish({ channel: 'stream:shared', type: 'tick', payload: { secret: 'b' } });
    const replayA = await pair.a.forActor(tenantA).events.replay('stream:shared');
    const replayB = await pair.a.forActor(tenantB).events.replay('stream:shared');
    expect(replayA.every((event) => event.tenantId === tenantA.tenantId)).toBe(true);
    expect(replayB.every((event) => event.tenantId === tenantB.tenantId)).toBe(true);
    expect(replayB).toHaveLength(1);
  });

  it('does not drop required conversation/job records or completion events when pruning ticks', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const bound = handle.kernel.forActor(tenantA);
    const conversation = await bound.conversations.create({ title: 'Keep', projectId: null });
    const job = await bound.jobs.enqueue(tenantA, { dungeon: 'writing', type: 'commission' });
    await bound.events.publish({
      channel: `conversation:${conversation.id}`,
      type: 'conversation.created',
      payload: { conversationId: conversation.id },
      conversationId: conversation.id,
    });
    for (let i = 0; i < 6; i += 1) {
      await bound.events.publish({ channel: `conversation:${conversation.id}`, type: 'tick', payload: { i } });
    }
    await handle.kernel.applyEventRetention(2);
    expect(await bound.conversations.get(conversation.id)).toBeTruthy();
    expect(await bound.jobs.get(tenantA, job.id)).toBeTruthy();
    const remaining = await bound.events.history(`conversation:${conversation.id}`);
    expect(remaining.some((event) => event.type === 'conversation.created')).toBe(true);
  });
});
