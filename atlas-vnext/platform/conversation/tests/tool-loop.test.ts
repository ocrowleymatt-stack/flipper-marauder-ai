import { describe, expect, it } from 'vitest';
import type { RouteDecision, StreamChunk, ToolCallRequest } from '@atlas-vnext/contracts';
import { MemoryEventBus } from '@atlas-vnext/events';
import {
  ConversationRuntime,
  memoryStores,
  type CapabilityRouter,
  type ModelExecutor,
  type ToolOrchestrator,
} from '../src/index.ts';

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
    traceId: 'trc_tools',
    evaluatedAt: '2026-09-14T00:00:00.000Z',
  };
}

describe('model/tool loop', () => {
  it('executes complete tool calls once then continues the model with structured results', async () => {
    const stores = memoryStores();
    const calls: ToolCallRequest[] = [];
    const orchestrator: ToolOrchestrator = {
      async handleCall(input) {
        calls.push(input.call);
        return {
          invocationId: `inv_${input.call.id}`,
          toolId: input.call.toolId,
          status: 'succeeded',
          resultRef: `ref:${input.call.id}`,
          output: { ok: true },
        };
      },
    };
    let round = 0;
    const executor: ModelExecutor = {
      async *execute(_decision, context, observer) {
        observer?.onAttempt({
          index: round + 1,
          provider: 'openai',
          model: 'gpt-4o',
          outcome: 'started',
          error: null,
          emittedVisibleOutput: false,
        });
        round += 1;
        if (round === 1) {
          yield {
            type: 'tool_call',
            call: { id: 'call_1', toolId: 'retrieval.search', arguments: { query: 'Alpha' } },
          } satisfies StreamChunk;
        } else {
          expect(context.priorToolResults?.[0]?.toolId).toBe('retrieval.search');
          yield { type: 'text', text: 'used retrieval.search' };
        }
        observer?.onAttempt({
          index: 1,
          provider: 'openai',
          model: 'gpt-4o',
          outcome: 'succeeded',
          error: null,
          emittedVisibleOutput: round > 1,
        });
        observer?.onSelected?.({ provider: 'openai', model: 'gpt-4o' });
      },
    };
    const runtime = new ConversationRuntime({
      ...stores,
      events: new MemoryEventBus(),
      router: { resolve: () => decision() } satisfies CapabilityRouter,
      executor,
      toolOrchestrator: orchestrator,
      principalId: 'user_a',
    });
    const conversation = await runtime.createConversation();
    Object.assign(conversation, { tenantId: 'tenant_a' });
    await stores.conversations.save(conversation);
    const events = [];
    for await (const event of runtime.sendMessage(conversation.id, { content: 'search please' })) {
      events.push(event);
    }
    expect(calls).toHaveLength(1);
    expect(events.some((event) => event.type === 'tool.lifecycle' && event.status === 'succeeded')).toBe(true);
    expect(events.some((event) => event.type === 'assistant.completed' && event.text.includes('retrieval.search'))).toBe(
      true,
    );
  });

  it('does not execute incomplete tool calls from the orchestrator', async () => {
    const stores = memoryStores();
    const orchestrator: ToolOrchestrator = {
      async handleCall() {
        throw new Error('should not be called for missing toolId');
      },
    };
    const executor: ModelExecutor = {
      async *execute(_decision, _context, observer) {
        observer?.onAttempt({
          index: 1,
          provider: 'openai',
          model: 'gpt-4o',
          outcome: 'started',
          error: null,
          emittedVisibleOutput: false,
        });
        yield { type: 'text', text: 'no tools' };
        observer?.onAttempt({
          index: 1,
          provider: 'openai',
          model: 'gpt-4o',
          outcome: 'succeeded',
          error: null,
          emittedVisibleOutput: true,
        });
        observer?.onSelected?.({ provider: 'openai', model: 'gpt-4o' });
      },
    };
    const runtime = new ConversationRuntime({
      ...stores,
      events: new MemoryEventBus(),
      router: { resolve: () => decision() } satisfies CapabilityRouter,
      executor,
      toolOrchestrator: orchestrator,
    });
    const conversation = await runtime.createConversation();
    const events = [];
    for await (const event of runtime.sendMessage(conversation.id, { content: 'hi' })) events.push(event);
    expect(events.some((event) => event.type === 'tool.lifecycle')).toBe(false);
  });

  it('runs two sequential search rounds then a final model response and persists the turn', async () => {
    const stores = memoryStores();
    const calls: ToolCallRequest[] = [];
    const orchestrator: ToolOrchestrator = {
      async handleCall(input) {
        calls.push(input.call);
        return {
          invocationId: `inv_${input.call.id}`,
          toolId: input.call.toolId,
          status: 'succeeded',
          resultRef: `ref:${input.call.id}`,
          output: { query: input.call.arguments.query },
        };
      },
    };
    const executor: ModelExecutor = {
      async *execute(_decision, context, observer) {
        const prior = context.priorToolResults ?? [];
        observer?.onAttempt({
          index: prior.length + 1,
          provider: 'openai',
          model: 'gpt-4o',
          outcome: 'started',
          error: null,
          emittedVisibleOutput: false,
        });
        if (prior.length === 0) {
          yield {
            type: 'tool_call',
            call: { id: 'call_1', toolId: 'retrieval.search', arguments: { query: 'one' } },
          } satisfies StreamChunk;
        } else if (prior.length === 1) {
          expect(prior[0]?.toolId).toBe('retrieval.search');
          yield {
            type: 'tool_call',
            call: { id: 'call_2', toolId: 'retrieval.search', arguments: { query: 'two' } },
          } satisfies StreamChunk;
        } else {
          expect(prior.map((row) => row.callId)).toEqual(['call_1', 'call_2']);
          yield { type: 'text', text: 'used both searches' };
        }
        observer?.onAttempt({
          index: prior.length + 1,
          provider: 'openai',
          model: 'gpt-4o',
          outcome: 'succeeded',
          error: null,
          emittedVisibleOutput: prior.length >= 2,
        });
        observer?.onSelected?.({ provider: 'openai', model: 'gpt-4o' });
      },
    };
    const runtime = new ConversationRuntime({
      ...stores,
      events: new MemoryEventBus(),
      router: { resolve: () => decision() } satisfies CapabilityRouter,
      executor,
      toolOrchestrator: orchestrator,
      principalId: 'user_a',
    });
    const conversation = await runtime.createConversation();
    Object.assign(conversation, { tenantId: 'tenant_a' });
    await stores.conversations.save(conversation);
    const events = [];
    for await (const event of runtime.sendMessage(conversation.id, { content: 'search twice' })) {
      events.push(event);
    }
    expect(calls.map((call) => call.id)).toEqual(['call_1', 'call_2']);
    expect(events.filter((event) => event.type === 'tool.lifecycle' && event.status === 'succeeded')).toHaveLength(2);
    expect(events.some((event) => event.type === 'assistant.completed' && event.text.includes('used both searches'))).toBe(
      true,
    );
    expect(events.some((event) => event.type === 'execution.completed')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
    const snapshot = await runtime.getSnapshot(conversation.id);
    expect(snapshot?.executions[0]?.status).toBe('completed');
    expect(snapshot?.messages.at(-1)?.content).toBe('used both searches');
    expect(await stores.executions.listInFlight()).toEqual([]);
  });

  it('fails closed when a later model pass requests tools after the round ceiling', async () => {
    const stores = memoryStores();
    const calls: string[] = [];
    const orchestrator: ToolOrchestrator = {
      async handleCall(input) {
        calls.push(input.call.id);
        return {
          invocationId: `inv_${input.call.id}`,
          toolId: input.call.toolId,
          status: 'succeeded',
          resultRef: `ref:${input.call.id}`,
          output: { ok: true },
        };
      },
    };
    const executor: ModelExecutor = {
      async *execute(_decision, context, observer) {
        const prior = context.priorToolResults ?? [];
        observer?.onAttempt({
          index: prior.length + 1,
          provider: 'openai',
          model: 'gpt-4o',
          outcome: 'started',
          error: null,
          emittedVisibleOutput: false,
        });
        yield {
          type: 'tool_call',
          call: {
            id: `call_${prior.length + 1}`,
            toolId: 'retrieval.search',
            arguments: { query: String(prior.length + 1) },
          },
        } satisfies StreamChunk;
        observer?.onAttempt({
          index: prior.length + 1,
          provider: 'openai',
          model: 'gpt-4o',
          outcome: 'succeeded',
          error: null,
          emittedVisibleOutput: false,
        });
        observer?.onSelected?.({ provider: 'openai', model: 'gpt-4o' });
      },
    };
    const runtime = new ConversationRuntime({
      ...stores,
      events: new MemoryEventBus(),
      router: { resolve: () => decision() } satisfies CapabilityRouter,
      executor,
      toolOrchestrator: orchestrator,
      principalId: 'user_a',
      maxToolRounds: 1,
    });
    const conversation = await runtime.createConversation();
    Object.assign(conversation, { tenantId: 'tenant_a' });
    await stores.conversations.save(conversation);
    const events = [];
    for await (const event of runtime.sendMessage(conversation.id, { content: 'keep searching' })) {
      events.push(event);
    }
    expect(calls).toEqual(['call_1']);
    expect(events.some((event) => event.type === 'error' && event.failure.code === 'tool_round_limit')).toBe(true);
    expect(events.some((event) => event.type === 'execution.completed')).toBe(false);
    expect(events.at(-1)?.type).toBe('done');
    expect((await runtime.getSnapshot(conversation.id))?.executions[0]?.status).toBe('failed');
    expect(await stores.executions.listInFlight()).toEqual([]);
  });

  it('cancels during a later tool round and tears the iterator down', async () => {
    const stores = memoryStores();
    let returnCalls = 0;
    let executeCalls = 0;
    const orchestrator: ToolOrchestrator = {
      async handleCall(input) {
        if (input.call.id === 'call_2') {
          await new Promise(() => undefined);
        }
        return {
          invocationId: `inv_${input.call.id}`,
          toolId: input.call.toolId,
          status: 'succeeded',
          resultRef: `ref:${input.call.id}`,
          output: { ok: true },
        };
      },
    };
    const executor: ModelExecutor = {
      execute(_decision, context) {
        executeCalls += 1;
        const round = executeCalls;
        const prior = context.priorToolResults ?? [];
        return {
          [Symbol.asyncIterator]() {
            let step = 0;
            return {
              async next() {
                step += 1;
                if (step === 1) {
                  return {
                    done: false,
                    value: {
                      type: 'tool_call' as const,
                      call: {
                        id: `call_${prior.length + 1}`,
                        toolId: 'retrieval.search',
                        arguments: { query: String(round) },
                      },
                    },
                  };
                }
                if (round === 1) return { done: true, value: undefined };
                await new Promise(() => undefined);
                return { done: true, value: undefined };
              },
              async return() {
                returnCalls += 1;
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
    };
    const runtime = new ConversationRuntime({
      ...stores,
      events: new MemoryEventBus(),
      router: { resolve: () => decision() } satisfies CapabilityRouter,
      executor,
      toolOrchestrator: orchestrator,
      principalId: 'user_a',
    });
    const conversation = await runtime.createConversation();
    Object.assign(conversation, { tenantId: 'tenant_a' });
    await stores.conversations.save(conversation);
    const gen = runtime.sendMessage(conversation.id, { content: 'cancel later' });
    const started = Date.now();
    let executionId: string | undefined;
    for (;;) {
      const { value, done } = await gen.next();
      if (done || !value) break;
      if (value.type === 'execution' && value.execution.id) executionId = value.execution.id;
      if (value.type === 'tool.requested' && value.call.id === 'call_2') {
        expect(executionId).toBeTruthy();
        await runtime.cancel(executionId!);
      }
    }
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(returnCalls).toBeGreaterThanOrEqual(1);
    expect(executeCalls).toBeGreaterThanOrEqual(2);
    expect(await stores.executions.listInFlight()).toEqual([]);
    expect((await runtime.getSnapshot(conversation.id))?.executions[0]?.status).toBe('cancelled');
  });

  it('surfaces a structured failure when the second tool round fails', async () => {
    const stores = memoryStores();
    const orchestrator: ToolOrchestrator = {
      async handleCall(input) {
        if (input.call.id === 'call_2') {
          return {
            invocationId: 'inv_2',
            toolId: input.call.toolId,
            status: 'failed',
            reason: 'search failed',
          };
        }
        return {
          invocationId: `inv_${input.call.id}`,
          toolId: input.call.toolId,
          status: 'succeeded',
          resultRef: `ref:${input.call.id}`,
          output: { ok: true },
        };
      },
    };
    const executor: ModelExecutor = {
      async *execute(_decision, context, observer) {
        const prior = context.priorToolResults ?? [];
        observer?.onAttempt({
          index: prior.length + 1,
          provider: 'openai',
          model: 'gpt-4o',
          outcome: 'started',
          error: null,
          emittedVisibleOutput: false,
        });
        yield {
          type: 'tool_call',
          call: {
            id: `call_${prior.length + 1}`,
            toolId: 'retrieval.search',
            arguments: { query: String(prior.length + 1) },
          },
        } satisfies StreamChunk;
        observer?.onAttempt({
          index: prior.length + 1,
          provider: 'openai',
          model: 'gpt-4o',
          outcome: 'succeeded',
          error: null,
          emittedVisibleOutput: false,
        });
        observer?.onSelected?.({ provider: 'openai', model: 'gpt-4o' });
      },
    };
    const runtime = new ConversationRuntime({
      ...stores,
      events: new MemoryEventBus(),
      router: { resolve: () => decision() } satisfies CapabilityRouter,
      executor,
      toolOrchestrator: orchestrator,
      principalId: 'user_a',
    });
    const conversation = await runtime.createConversation();
    Object.assign(conversation, { tenantId: 'tenant_a' });
    await stores.conversations.save(conversation);
    const events = [];
    for await (const event of runtime.sendMessage(conversation.id, { content: 'second fails' })) {
      events.push(event);
    }
    expect(events.some((event) => event.type === 'tool.lifecycle' && event.status === 'failed')).toBe(true);
    expect(events.some((event) => event.type === 'error' && event.failure.code === 'tool_failed')).toBe(true);
    expect(events.some((event) => event.type === 'execution.completed')).toBe(false);
    expect(events.at(-1)?.type).toBe('done');
    expect((await runtime.getSnapshot(conversation.id))?.executions[0]?.status).toBe('failed');
    expect(await stores.executions.listInFlight()).toEqual([]);
  });

  it('fails the turn when the overall execution deadline elapses during a later tool round', async () => {
    const stores = memoryStores();
    const orchestrator: ToolOrchestrator = {
      async handleCall(input) {
        if (input.call.id === 'call_2') {
          await new Promise(() => undefined);
        }
        return {
          invocationId: `inv_${input.call.id}`,
          toolId: input.call.toolId,
          status: 'succeeded',
          resultRef: `ref:${input.call.id}`,
          output: { ok: true },
        };
      },
    };
    const executor: ModelExecutor = {
      async *execute(_decision, context, observer) {
        const prior = context.priorToolResults ?? [];
        observer?.onAttempt({
          index: prior.length + 1,
          provider: 'openai',
          model: 'gpt-4o',
          outcome: 'started',
          error: null,
          emittedVisibleOutput: false,
        });
        yield {
          type: 'tool_call',
          call: {
            id: `call_${prior.length + 1}`,
            toolId: 'retrieval.search',
            arguments: { query: String(prior.length + 1) },
          },
        } satisfies StreamChunk;
        observer?.onAttempt({
          index: prior.length + 1,
          provider: 'openai',
          model: 'gpt-4o',
          outcome: 'succeeded',
          error: null,
          emittedVisibleOutput: false,
        });
        observer?.onSelected?.({ provider: 'openai', model: 'gpt-4o' });
      },
    };
    const runtime = new ConversationRuntime({
      ...stores,
      events: new MemoryEventBus(),
      router: { resolve: () => decision() } satisfies CapabilityRouter,
      executor,
      toolOrchestrator: orchestrator,
      principalId: 'user_a',
      executionDeadlineMs: 40,
    });
    const conversation = await runtime.createConversation();
    Object.assign(conversation, { tenantId: 'tenant_a' });
    await stores.conversations.save(conversation);
    const events = [];
    const started = Date.now();
    for await (const event of runtime.sendMessage(conversation.id, { content: 'deadline later' })) {
      events.push(event);
    }
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(events.some((event) => event.type === 'error' && event.failure.code === 'timeout')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
    expect((await runtime.getSnapshot(conversation.id))?.executions[0]?.status).toBe('failed');
    expect(await stores.executions.listInFlight()).toEqual([]);
  });
});
