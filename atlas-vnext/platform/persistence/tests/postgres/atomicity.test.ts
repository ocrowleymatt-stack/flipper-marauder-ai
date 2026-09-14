import { afterEach, describe, expect, it } from 'vitest';
import { OwnershipError } from '../../src/errors.ts';
import { openTestKernel, tenantA } from './harness.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe('transactional atomicity', () => {
  it('rolls back a partial conversation/message/execution write', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const bound = handle.kernel.forActor(tenantA);
    const conversation = await bound.conversations.create({ title: 'Atomic', projectId: null });
    await expect(
      handle.kernel.run(async () => {
        await bound.messages.append({
          conversationId: conversation.id,
          role: 'user',
          content: 'should not commit',
          executionId: null,
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow(/boom/);
    const messages = await bound.messages.list(conversation.id);
    expect(messages).toEqual([]);
    const executions = await bound.executions.listByConversation(conversation.id);
    expect(executions).toEqual([]);
  });

  it('commits job checkpoint and job row together', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const jobs = handle.kernel.forActor(tenantA).jobs;
    const job = await jobs.enqueue(tenantA, { dungeon: 'writing', type: 'commission', maxRetries: 2 });
    const claimed = await jobs.claimNext(tenantA, 'w1', 30_000);
    expect(claimed?.id).toBe(job.id);
    await jobs.checkpoint(tenantA, job.id, 'outline', 0.25, { beats: 3 });
    const reloaded = await jobs.get(tenantA, job.id);
    expect(reloaded?.currentStage).toBe('outline');
    expect(reloaded?.checkpoint).toEqual({ beats: 3 });
  });

  it('rejects missing tenancy fail-closed', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    expect(() => handle.kernel.forActor({ tenantId: '' })).toThrow(OwnershipError);
  });
});
