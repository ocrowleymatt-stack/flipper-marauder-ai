import { describe, expect, it } from 'vitest';
import type { RouteDecision, StreamChunk, ToolCallRequest } from '@atlas-vnext/contracts';
import { ExecutionBroker } from '@atlas-vnext/execution';
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
    for await (const event of runtime.sendMessage(conversation.id, { content: 'search please', allowTools: true })) {
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
          expect(prior[0]?.arguments).toEqual({ query: 'one' });
          expect(prior[0]?.round).toBe(0);
          yield {
            type: 'tool_call',
            call: { id: 'call_2', toolId: 'retrieval.search', arguments: { query: 'two' } },
          } satisfies StreamChunk;
        } else {
          expect(prior.map((row) => row.callId)).toEqual(['call_1', 'call_2']);
          expect(prior.map((row) => row.arguments)).toEqual([{ query: 'one' }, { query: 'two' }]);
          expect(prior.map((row) => row.round)).toEqual([0, 1]);
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
    for await (const event of runtime.sendMessage(conversation.id, { content: 'search twice', allowTools: true })) {
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

  it('accumulates token usage across two tool rounds rather than keeping only the last round', async () => {
    const stores = memoryStores();
    const orchestrator: ToolOrchestrator = {
      async handleCall(input) {
        return {
          invocationId: `inv_${input.call.id}`,
          toolId: input.call.toolId,
          status: 'succeeded',
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
        if (prior.length === 0) {
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } };
          yield {
            type: 'tool_call',
            call: { id: 'call_1', toolId: 'retrieval.search', arguments: { query: 'one' } },
          } satisfies StreamChunk;
        } else {
          yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 6, totalTokens: 26 } };
          yield { type: 'text', text: 'done' };
        }
        observer?.onAttempt({
          index: prior.length + 1,
          provider: 'openai',
          model: 'gpt-4o',
          outcome: 'succeeded',
          error: null,
          emittedVisibleOutput: prior.length > 0,
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
    for await (const _event of runtime.sendMessage(conversation.id, { content: 'search then answer', allowTools: true })) {
      // drain
    }
    const snapshot = await runtime.getSnapshot(conversation.id);
    expect(snapshot?.executions[0]?.status).toBe('completed');
    expect(snapshot?.executions[0]?.usage).toEqual({ inputTokens: 30, outputTokens: 10, totalTokens: 40 });
    const provenance = await stores.provenance.forJob(snapshot!.executions[0]!.id);
    expect(provenance[0]?.usage).toEqual({ inputTokens: 30, outputTokens: 10, totalTokens: 40 });
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
    for await (const event of runtime.sendMessage(conversation.id, { content: 'keep searching', allowTools: true })) {
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
          await new Promise<void>((_resolve, reject) => {
            if (input.signal?.aborted) {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              return;
            }
            input.signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true },
            );
          });
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
    const gen = runtime.sendMessage(conversation.id, { content: 'cancel later', allowTools: true });
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
    for await (const event of runtime.sendMessage(conversation.id, { content: 'second fails', allowTools: true })) {
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
          await new Promise<void>((_resolve, reject) => {
            if (input.signal?.aborted) {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              return;
            }
            input.signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true },
            );
          });
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
    for await (const event of runtime.sendMessage(conversation.id, { content: 'deadline later', allowTools: true })) {
      events.push(event);
    }
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(events.some((event) => event.type === 'error' && event.failure.code === 'timeout')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
    expect((await runtime.getSnapshot(conversation.id))?.executions[0]?.status).toBe('failed');
    expect(await stores.executions.listInFlight()).toEqual([]);
  });

  it('supplies only authorised callable tool definitions to every model round', async () => {
    const stores = memoryStores();
    const seen: Array<{ tools?: Array<{ id: string }>; prior?: number }> = [];
    const orchestrator: ToolOrchestrator = {
      async listCallable(input) {
        if (input.tenantId !== 'tenant_a' || input.principalId !== 'user_a') return [];
        return [
          {
            id: 'retrieval.search',
            description: 'Read-only lexical retrieval over mock knowledge.',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          },
        ];
      },
      async handleCall(input) {
        return {
          invocationId: `inv_${input.call.id}`,
          toolId: input.call.toolId,
          status: 'succeeded',
          output: { ok: true, tenantId: input.tenantId },
        };
      },
    };
    const executor: ModelExecutor = {
      async *execute(_decision, context, observer) {
        seen.push({ tools: context.tools?.map((tool) => ({ id: tool.id })), prior: context.priorToolResults?.length ?? 0 });
        observer?.onAttempt({
          index: (context.priorToolResults?.length ?? 0) + 1,
          provider: 'openai',
          model: 'gpt-4o',
          outcome: 'started',
          error: null,
          emittedVisibleOutput: false,
        });
        if (!context.priorToolResults?.length) {
          yield {
            type: 'tool_call',
            call: { id: 'call_1', toolId: 'retrieval.search', arguments: { query: 'one' } },
          } satisfies StreamChunk;
        } else {
          expect(context.tools?.map((tool) => tool.id)).toEqual(['retrieval.search']);
          yield { type: 'text', text: 'done' };
        }
        observer?.onAttempt({
          index: 1,
          provider: 'openai',
          model: 'gpt-4o',
          outcome: 'succeeded',
          error: null,
          emittedVisibleOutput: Boolean(context.priorToolResults?.length),
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
    for await (const _event of runtime.sendMessage(conversation.id, { content: 'search', requireTools: true, allowTools: true })) {
      // drain
    }
    expect(seen).toHaveLength(2);
    expect(seen[0]?.tools).toEqual([{ id: 'retrieval.search' }]);
    expect(seen[1]?.tools).toEqual([{ id: 'retrieval.search' }]);
  });

  it('does not advertise another tenant\'s tools or leak their results', async () => {
    const stores = memoryStores();
    const seenTools: string[][] = [];
    const orchestrator: ToolOrchestrator = {
      async listCallable(input) {
        if (input.tenantId !== 'tenant_a') {
          return [{ id: 'admin.configure', description: 'secret', inputSchema: { type: 'object' } }];
        }
        return [{ id: 'retrieval.search', description: 'search', inputSchema: { type: 'object' } }];
      },
      async handleCall(input) {
        expect(input.tenantId).toBe('tenant_a');
        return {
          invocationId: 'inv_1',
          toolId: input.call.toolId,
          status: 'succeeded',
          output: { secret: 'tenant-a-only' },
        };
      },
    };
    const executor: ModelExecutor = {
      async *execute(_decision, context) {
        seenTools.push((context.tools ?? []).map((tool) => tool.id));
        expect(context.tools?.some((tool) => tool.id === 'admin.configure')).toBe(false);
        yield { type: 'text', text: 'ok' };
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
    for await (const _event of runtime.sendMessage(conversation.id, { content: 'hi', requireTools: true, allowTools: true })) {
      // drain
    }
    expect(seenTools).toEqual([['retrieval.search']]);
  });

  it('does not advertise or handle tools when the product request is tools-off', async () => {
    const stores = memoryStores();
    const listed: string[] = [];
    const handled: string[] = [];
    const seenTools: Array<string[] | undefined> = [];
    const orchestrator: ToolOrchestrator = {
      async listCallable() {
        listed.push('listCallable');
        return [
          { id: 'retrieval.search', description: 'search', inputSchema: { type: 'object' } },
          { id: 'job.run', description: 'enqueue', inputSchema: { type: 'object' } },
          { id: 'project.file_op', description: 'jail file op', inputSchema: { type: 'object' } },
        ];
      },
      async handleCall(input) {
        handled.push(input.call.toolId);
        throw new Error(`handleCall must not run for ${input.call.toolId} on a tools-off request`);
      },
    };
    const executor: ModelExecutor = {
      async *execute(_decision, context, observer) {
        seenTools.push(context.tools?.map((tool) => tool.id));
        observer?.onAttempt({
          index: 1,
          provider: 'openai',
          model: 'gpt-4o',
          outcome: 'started',
          error: null,
          emittedVisibleOutput: false,
        });
        yield {
          type: 'tool_call',
          call: { id: 'call_job', toolId: 'job.run', arguments: { label: 'sneak' } },
        } satisfies StreamChunk;
        yield {
          type: 'tool_call',
          call: { id: 'call_file', toolId: 'project.file_op', arguments: { op: 'stat', path: '.' } },
        } satisfies StreamChunk;
        yield {
          type: 'tool_call',
          call: { id: 'call_search', toolId: 'retrieval.search', arguments: { query: 'injected' } },
        } satisfies StreamChunk;
        yield { type: 'text', text: 'plain answer' };
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
      principalId: 'user_a',
    });
    const conversation = await runtime.createConversation();
    Object.assign(conversation, { tenantId: 'tenant_a' });
    await stores.conversations.save(conversation);
    const events = [];
    for await (const event of runtime.sendMessage(conversation.id, { content: 'hi', requireTools: true })) {
      events.push(event);
    }
    expect(listed).toEqual([]);
    expect(handled).toEqual([]);
    expect(seenTools).toEqual([undefined]);
    expect(events.some((event) => event.type === 'tool.lifecycle')).toBe(false);
    expect(events.some((event) => event.type === 'tool.requested')).toBe(false);
    expect(events.some((event) => event.type === 'assistant.completed' && event.text.includes('plain answer'))).toBe(
      true,
    );
  });

  it('propagates cancellation into an active tool handleCall via the execution signal', async () => {
    const stores = memoryStores();
    let sawAbort = false;
    const orchestrator: ToolOrchestrator = {
      async handleCall(input) {
        await new Promise<void>((resolve, reject) => {
          if (input.signal?.aborted) {
            sawAbort = true;
            resolve();
            return;
          }
          input.signal?.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        return {
          invocationId: 'inv_hang',
          toolId: input.call.toolId,
          status: 'cancelled',
          reason: 'cancelled while running',
        };
      },
    };
    const executor: ModelExecutor = {
      async *execute() {
        yield {
          type: 'tool_call',
          call: { id: 'call_hang', toolId: 'retrieval.search', arguments: { query: 'hang' } },
        } satisfies StreamChunk;
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
    const gen = runtime.sendMessage(conversation.id, { content: 'hang', allowTools: true });
    let executionId: string | undefined;
    const events = [];
    for (;;) {
      const { value, done } = await gen.next();
      if (done || !value) break;
      events.push(value);
      if (value.type === 'execution' && value.execution.id) executionId = value.execution.id;
      if (value.type === 'tool.requested') {
        await runtime.cancel(executionId!);
      }
    }
    expect(sawAbort).toBe(true);
    expect(events.some((event) => event.type === 'tool.lifecycle' && event.status === 'cancelled')).toBe(true);
    expect((await runtime.getSnapshot(conversation.id))?.executions[0]?.status).toBe('cancelled');
  });

  it('surfaces uncertain completion when a mutating tool is cancelled mid-flight', async () => {
    const stores = memoryStores();
    let sawAbort = false;
    const orchestrator: ToolOrchestrator = {
      async handleCall(input) {
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) {
            sawAbort = true;
            resolve();
            return;
          }
          input.signal?.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        return {
          invocationId: 'inv_mutate',
          toolId: input.call.toolId,
          status: 'uncertain',
          reason: 'Cancellation interrupted a mutating tool; completion is uncertain and requires reconciliation.',
        };
      },
    };
    const executor: ModelExecutor = {
      async *execute() {
        yield {
          type: 'tool_call',
          call: { id: 'call_mutate', toolId: 'api.mutate', arguments: { url: 'https://example.test' } },
        } satisfies StreamChunk;
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
    const gen = runtime.sendMessage(conversation.id, { content: 'mutate', allowTools: true });
    let executionId: string | undefined;
    const events = [];
    for (;;) {
      const { value, done } = await gen.next();
      if (done || !value) break;
      events.push(value);
      if (value.type === 'execution' && value.execution.id) executionId = value.execution.id;
      if (value.type === 'tool.requested') {
        await runtime.cancel(executionId!);
      }
    }
    expect(sawAbort).toBe(true);
    expect(events.some((event) => event.type === 'tool.lifecycle' && event.status === 'uncertain')).toBe(true);
    expect((await runtime.getSnapshot(conversation.id))?.executions[0]?.status).toBe('cancelled');
  });

  it('does not switch provider after visible output on a later tool round', async () => {
    const stores = memoryStores();
    const routes: string[] = [];
    const orchestrator: ToolOrchestrator = {
      async handleCall(input) {
        return {
          invocationId: `inv_${input.call.id}`,
          toolId: input.call.toolId,
          status: 'succeeded',
          output: { ok: true },
        };
      },
    };
    const executor: ModelExecutor = {
      async *execute(routed, context, observer) {
        routes.push(`${routed.provider}/${routed.model}`);
        observer?.onAttempt({
          index: routes.length,
          provider: routed.provider,
          model: routed.model,
          outcome: 'started',
          error: null,
          emittedVisibleOutput: false,
        });
        observer?.onSelected?.({ provider: routed.provider, model: routed.model });
        if (!context.priorToolResults?.length) {
          yield { type: 'text', text: 'visible ' };
          yield {
            type: 'tool_call',
            call: { id: 'call_1', toolId: 'retrieval.search', arguments: { query: 'one' } },
          } satisfies StreamChunk;
        } else {
          yield { type: 'text', text: 'again' };
        }
        observer?.onAttempt({
          index: routes.length,
          provider: routed.provider,
          model: routed.model,
          outcome: 'succeeded',
          error: null,
          emittedVisibleOutput: true,
        });
      },
    };
    const runtime = new ConversationRuntime({
      ...stores,
      events: new MemoryEventBus(),
      router: {
        resolve: () => ({
          ...decision(),
          candidateChain: ['openai/gpt-4o', 'anthropic/claude-sonnet'],
        }),
      } satisfies CapabilityRouter,
      executor,
      toolOrchestrator: orchestrator,
      principalId: 'user_a',
    });
    const conversation = await runtime.createConversation();
    Object.assign(conversation, { tenantId: 'tenant_a' });
    await stores.conversations.save(conversation);
    for await (const _event of runtime.sendMessage(conversation.id, { content: 'stay', allowTools: true })) {
      // drain
    }
    expect(routes).toEqual(['openai/gpt-4o', 'openai/gpt-4o']);
  });

  it('does not failover after visible reasoning even when later rounds have empty assembled text', async () => {
    const stores = memoryStores();
    const broker = new ExecutionBroker(1);
    const providers: string[] = [];
    broker.register({
      providerId: 'openai',
      async *stream(_model, context) {
        providers.push('openai');
        const round = context.priorToolResults?.length ?? 0;
        if (round === 0) {
          yield { type: 'reasoning', text: 'planning the search' };
          yield {
            type: 'tool_call',
            call: { id: 'c1', toolId: 'retrieval.search', arguments: { query: 'one' } },
          } satisfies StreamChunk;
          return;
        }
        if (round === 1) {
          yield {
            type: 'tool_call',
            call: { id: 'c2', toolId: 'retrieval.search', arguments: { query: 'two' } },
          } satisfies StreamChunk;
          return;
        }
        throw new Error('third round provider died');
      },
    });
    broker.register({
      providerId: 'anthropic',
      async *stream() {
        providers.push('anthropic');
        yield { type: 'text', text: 'FAILOVER AFTER REASONING' };
      },
    });
    const orchestrator: ToolOrchestrator = {
      async handleCall(input) {
        return {
          invocationId: `inv_${input.call.id}`,
          toolId: input.call.toolId,
          status: 'succeeded',
          output: { ok: true },
        };
      },
    };
    const runtime = new ConversationRuntime({
      ...stores,
      events: new MemoryEventBus(),
      router: {
        resolve: () => ({
          ...decision(),
          candidateChain: ['openai/gpt-4o', 'anthropic/claude-sonnet'],
        }),
      } satisfies CapabilityRouter,
      executor: broker,
      toolOrchestrator: orchestrator,
      principalId: 'user_a',
    });
    const conversation = await runtime.createConversation();
    Object.assign(conversation, { tenantId: 'tenant_a' });
    await stores.conversations.save(conversation);
    const events = [];
    for await (const event of runtime.sendMessage(conversation.id, { content: 'stay after reasoning', allowTools: true })) {
      events.push(event);
    }
    expect(providers).toEqual(['openai', 'openai', 'openai']);
    expect(
      events.some((event) => event.type === 'assistant.delta' && event.text.includes('FAILOVER AFTER REASONING')),
    ).toBe(false);
    const snapshot = await runtime.getSnapshot(conversation.id);
    const attemptRecords = snapshot?.executions[0]?.attempts ?? [];
    const indices = attemptRecords.map((attempt) => attempt.index);
    expect(indices.length).toBeGreaterThan(1);
    expect(new Set(indices).size).toBe(indices.length);
    expect(attemptRecords.some((attempt) => attempt.emittedVisibleOutput)).toBe(true);
    expect(snapshot?.executions[0]?.status).toBe('failed');
    expect(snapshot?.messages.at(-1)?.role).toBe('user');
  });
});
