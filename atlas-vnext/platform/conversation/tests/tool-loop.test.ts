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
});
