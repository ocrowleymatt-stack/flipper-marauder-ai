import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionRecord, RouteDecision } from '@atlas-vnext/contracts';
import { openPairedKernels, openTestKernel, tenantA } from './harness.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function decision(): RouteDecision {
  return {
    target: 'nexus/fast',
    resolvedRouteId: 'openai/gpt-4o',
    provider: 'openai',
    model: 'gpt-4o',
    candidateChain: ['openai/gpt-4o'],
    localOnly: false,
    locality: 'public_cloud',
    runtimeClass: 'always_available',
    decisionReason: 'test',
    traceId: 'trc_idemp',
    evaluatedAt: '2026-09-14T00:00:00.000Z',
  };
}

function execution(input: { id: string; conversationId: string; userMessageId: string }): ExecutionRecord {
  return {
    id: input.id,
    urn: `urn:atlas:execution:${input.id}`,
    conversationId: input.conversationId,
    userMessageId: input.userMessageId,
    assistantMessageId: null,
    tenantId: tenantA.tenantId,
    status: 'queued',
    capability: 'nexus/fast',
    route: decision(),
    selectedProvider: 'openai',
    selectedModel: 'gpt-4o',
    attempts: [],
    usage: null,
    failureReason: null,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
  };
}

describe('database-backed idempotency', () => {
  it('returns the committed message on duplicate submit', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const bound = handle.kernel.forActor(tenantA);
    const conversation = await bound.conversations.create({ title: 'Idempotent', projectId: null });
    const first = await bound.messages.append({
      conversationId: conversation.id,
      role: 'user',
      content: 'hello',
      executionId: null,
      idempotencyKey: 'msg-1',
    });
    const retry = await bound.messages.append({
      conversationId: conversation.id,
      role: 'user',
      content: 'hello again',
      executionId: null,
      idempotencyKey: 'msg-1',
    });
    expect(retry.id).toBe(first.id);
    expect(retry.content).toBe('hello');
    expect(await bound.messages.list(conversation.id)).toHaveLength(1);
  });

  it('returns the committed execution when create or complete is retried', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const bound = handle.kernel.forActor(tenantA);
    const conversation = await bound.conversations.create({ title: 'Turn', projectId: null });
    const user = await bound.messages.append({
      conversationId: conversation.id,
      role: 'user',
      content: 'go',
      executionId: null,
    });
    const first = await bound.executions.create(
      execution({ id: 'exe_one', conversationId: conversation.id, userMessageId: user.id }),
    );
    const duplicate = await bound.executions.create(
      execution({ id: 'exe_two', conversationId: conversation.id, userMessageId: user.id }),
    );
    expect(duplicate.id).toBe(first.id);
    const completed = await bound.executions.save({
      ...first,
      status: 'completed',
      updatedAt: '2026-09-14T00:01:00.000Z',
      completedAt: '2026-09-14T00:01:00.000Z',
    });
    const retry = await bound.executions.save({
      ...completed,
      status: 'completed',
      updatedAt: '2026-09-14T00:02:00.000Z',
      completedAt: '2026-09-14T00:02:00.000Z',
    });
    expect(retry.completedAt).toBe(completed.completedAt);
    expect(await bound.executions.listByConversation(conversation.id)).toHaveLength(1);
  });

  it('returns the committed event when two kernels retry the same append', async () => {
    const pair = await openPairedKernels();
    cleanups.push(pair.close);
    await pair.a.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const [one, two] = await Promise.all([
      pair.a.forActor(tenantA).events.publish({
        channel: 'conversation:cnv_dup',
        type: 'execution.completed',
        payload: { n: 1 },
        idempotencyKey: 'turn-complete',
      }),
      pair.b.forActor(tenantA).events.publish({
        channel: 'conversation:cnv_dup',
        type: 'execution.completed',
        payload: { n: 99 },
        idempotencyKey: 'turn-complete',
      }),
    ]);
    expect(one.eventId).toBe(two.eventId);
    expect(one.seq).toBe(two.seq);
    const replay = await pair.a.forActor(tenantA).events.history('conversation:cnv_dup');
    expect(replay).toHaveLength(1);
  });
});
