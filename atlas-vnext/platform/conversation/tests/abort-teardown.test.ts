import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@atlas-vnext/events';
import { ConversationRuntime, memoryStores, type ModelExecutor } from '../src/index.ts';

const route = {
  target: 'nexus/fast',
  resolvedRouteId: 'openai/gpt-4o',
  provider: 'openai',
  model: 'gpt-4o',
  candidateChain: ['openai/gpt-4o'],
  localOnly: false,
  locality: 'public_cloud' as const,
  runtimeClass: 'always_available' as const,
  decisionReason: 'test-route',
  traceId: 'trc_test',
  evaluatedAt: '2026-09-14T00:00:00.000Z',
};

describe('abort teardown against non-cooperative providers', () => {
  it('unblocks sendMessage when next() hangs after visible output and abort is ignored', async () => {
    const stores = memoryStores();
    let executeCalls = 0;
    let nextCalls = 0;
    let returnCalls = 0;
    const executor: ModelExecutor = {
      execute() {
        executeCalls += 1;
        const ignoreAbort = executeCalls === 1;
        return {
          [Symbol.asyncIterator]() {
            let yielded = false;
            return {
              async next() {
                nextCalls += 1;
                if (!yielded) {
                  yielded = true;
                  return { done: false, value: { type: 'text' as const, text: ignoreAbort ? 'visible' : 'recovered' } };
                }
                if (!ignoreAbort) return { done: true, value: undefined };
                await new Promise(() => undefined);
                return { done: true, value: undefined };
              },
              async return() {
                returnCalls += 1;
                if (ignoreAbort) await new Promise(() => undefined);
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
    };
    const runtime = new ConversationRuntime({
      conversations: stores.conversations,
      messages: stores.messages,
      executions: stores.executions,
      provenance: stores.provenance,
      events: new MemoryEventBus(),
      maxConcurrentExecutions: 1,
      router: { resolve: () => route },
      executor,
    });
    const conversation = await runtime.createConversation();
    const gen = runtime.sendMessage(conversation.id, { content: 'hang please' });
    const started = Date.now();
    let executionId: string | undefined;
    for (;;) {
      const { value, done } = await gen.next();
      if (done || !value) break;
      if (value.type === 'execution' && value.execution.status === 'running') {
        executionId = value.execution.id;
      }
      if (value.type === 'assistant.delta') break;
    }
    expect(executionId).toBeTruthy();
    await runtime.cancel(executionId!);
    await runtime.cancel(executionId!);
    for (;;) {
      const { done } = await gen.next();
      if (done) break;
    }
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(returnCalls).toBeGreaterThanOrEqual(1);
    expect(await stores.executions.listInFlight()).toEqual([]);
    expect((await runtime.getSnapshot(conversation.id))?.executions[0]?.status).toBe('cancelled');
    expect((await stores.messages.list(conversation.id)).at(-1)?.content).toBe('visible');
    const events = [];
    for await (const event of runtime.sendMessage(conversation.id, { content: 'next turn' })) events.push(event);
    expect(events.at(-1)?.type).toBe('done');
    expect(events.some((event) => event.type === 'error' && event.failure.code === 'rate_limit')).toBe(false);
    expect((await stores.messages.list(conversation.id)).at(-1)?.content).toBe('recovered');
  });

  it('finalizes inflight when generator.return follows cancel after visible output', async () => {
    const stores = memoryStores();
    let executeCalls = 0;
    const executor: ModelExecutor = {
      execute() {
        executeCalls += 1;
        const ignoreAbort = executeCalls === 1;
        return {
          [Symbol.asyncIterator]() {
            let yielded = false;
            return {
              async next() {
                if (!yielded) {
                  yielded = true;
                  return { done: false, value: { type: 'text' as const, text: ignoreAbort ? 'partial' : 'recovered' } };
                }
                if (!ignoreAbort) return { done: true, value: undefined };
                await new Promise(() => undefined);
                return { done: true, value: undefined };
              },
              async return() {
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
    };
    const runtime = new ConversationRuntime({
      conversations: stores.conversations,
      messages: stores.messages,
      executions: stores.executions,
      provenance: stores.provenance,
      events: new MemoryEventBus(),
      maxConcurrentExecutions: 1,
      router: { resolve: () => route },
      executor,
    });
    const conversation = await runtime.createConversation();
    const gen = runtime.sendMessage(conversation.id, { content: 'race teardown' });
    let executionId: string | undefined;
    for (;;) {
      const { value, done } = await gen.next();
      if (done || !value) break;
      if (value.type === 'execution' && value.execution.id) executionId = value.execution.id;
      if (value.type === 'assistant.delta') break;
    }
    expect(executionId).toBeTruthy();
    await runtime.cancel(executionId!);
    for (;;) {
      const { done } = await gen.next();
      if (done) break;
    }
    await gen.return?.(undefined);
    expect(await stores.executions.listInFlight()).toEqual([]);
    const snapshot = await runtime.getSnapshot(conversation.id);
    expect(snapshot?.executions[0]?.status).toBe('cancelled');
    expect(snapshot?.messages.at(-1)?.content).toBe('partial');
    const events = [];
    for await (const event of runtime.sendMessage(conversation.id, { content: 'after teardown' })) events.push(event);
    expect(events.some((event) => event.type === 'execution.completed')).toBe(true);
  });
});
