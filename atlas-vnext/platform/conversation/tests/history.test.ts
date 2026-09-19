import { describe, expect, it } from 'vitest';
import type { RouteDecision, StreamChunk } from '@atlas-vnext/contracts';
import { MemoryEventBus } from '@atlas-vnext/events';
import {
  ConversationRuntime,
  compileConversationHistory,
  HISTORY_MESSAGE_LIMIT,
  memoryStores,
  type CapabilityRouter,
  type ModelExecutor,
} from '../src/index.ts';

function decision(target: string, chain: string[]): RouteDecision {
  const [primary] = chain;
  const [provider, model] = (primary ?? 'mock/atlas').split('/');
  return {
    target,
    resolvedRouteId: primary ?? 'mock/atlas',
    provider: provider ?? 'mock',
    model: model ?? 'atlas',
    candidateChain: chain,
    localOnly: false,
    locality: 'public_cloud',
    runtimeClass: 'always_available',
    decisionReason: 'test-route',
    traceId: 'trc_test',
    evaluatedAt: '2026-09-19T00:00:00.000Z',
  };
}

function capturingExecutor(captured: Array<{ prompt: string; history?: Array<{ role: string; content: string }> }>): ModelExecutor {
  return {
    async *execute(routed, context, observer) {
      captured.push({ prompt: context.prompt, history: context.history });
      observer?.onAttempt({
        index: 1,
        provider: routed.provider,
        model: routed.model,
        outcome: 'started',
        error: null,
        emittedVisibleOutput: false,
      });
      const lastUser = context.history?.map((row) => row.content).join('\n') ?? '';
      const named = lastUser.match(/ORPHEUS-731/);
      const text =
        /dog/i.test(context.prompt) && named
          ? 'ORPHEUS-731'
          : `echo:${context.prompt}`;
      yield { type: 'text', text } satisfies StreamChunk;
      observer?.onAttempt({
        index: 1,
        provider: routed.provider,
        model: routed.model,
        outcome: 'succeeded',
        error: null,
        emittedVisibleOutput: true,
      });
    },
  };
}

describe('conversation history', () => {
  it('bounds compiled history', () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({
      id: `m${index}`,
      urn: `urn:atlas:message:m${index}`,
      conversationId: 'c1',
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `turn ${index} ${'x'.repeat(20)}`,
      sequence: index,
      executionId: null,
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z',
    }));
    const compiled = compileConversationHistory(messages);
    expect(compiled.length).toBeLessThanOrEqual(HISTORY_MESSAGE_LIMIT);
    expect(compiled.at(-1)?.content).toContain('turn 39');
  });

  it('truncates a single oversized turn to the character budget', () => {
    const compiled = compileConversationHistory(
      [
        {
          id: 'm1',
          urn: 'urn:atlas:message:m1',
          conversationId: 'c1',
          role: 'user',
          content: 'x'.repeat(80),
          sequence: 0,
          executionId: null,
          createdAt: '2026-09-19T00:00:00.000Z',
          updatedAt: '2026-09-19T00:00:00.000Z',
        },
      ],
      { charBudget: 24 },
    );
    expect(compiled).toHaveLength(1);
    expect(compiled[0]?.content).toHaveLength(24);
  });

  it('never exceeds the character budget across multiple turns', () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      id: `m${index}`,
      urn: `urn:atlas:message:m${index}`,
      conversationId: 'c1',
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `turn ${index} ${'y'.repeat(2_000)}`,
      sequence: index,
      executionId: null,
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z',
    }));
    const compiled = compileConversationHistory(messages);
    const chars = compiled.reduce((sum, row) => sum + row.content.length, 0);
    expect(compiled.length).toBeLessThanOrEqual(HISTORY_MESSAGE_LIMIT);
    expect(chars).toBeLessThanOrEqual(24_000);
  });

  it('feeds prior turns to the executor so anaphora can resolve', async () => {
    const stores = memoryStores();
    const captured: Array<{ prompt: string; history?: Array<{ role: string; content: string }> }> = [];
    const runtime = new ConversationRuntime({
      conversations: stores.conversations,
      messages: stores.messages,
      executions: stores.executions,
      provenance: stores.provenance,
      events: new MemoryEventBus(),
      router: { resolve: (target) => decision(target, ['mock/atlas']) } satisfies CapabilityRouter,
      executor: capturingExecutor(captured),
    });
    const conversation = await runtime.createConversation({ title: 'Memory' });
    for await (const _ of runtime.sendMessage(conversation.id, { content: "My dog's name is ORPHEUS-731." })) {
      void _;
    }
    for await (const _ of runtime.sendMessage(conversation.id, { content: 'Noted, thanks.' })) {
      void _;
    }
    const events = [];
    for await (const event of runtime.sendMessage(conversation.id, { content: "What did I say my dog's name was?" })) {
      events.push(event);
    }
    const completed = events.find((event) => event.type === 'assistant.completed');
    expect(completed && completed.type === 'assistant.completed' ? completed.text : '').toContain('ORPHEUS-731');
    expect(captured.at(-1)?.history?.some((turn) => turn.content.includes('ORPHEUS-731'))).toBe(true);

    const restarted = new ConversationRuntime({
      conversations: stores.conversations,
      messages: stores.messages,
      executions: stores.executions,
      provenance: stores.provenance,
      events: new MemoryEventBus(),
      router: { resolve: (target) => decision(target, ['mock/atlas']) },
      executor: capturingExecutor([]),
    });
    const snap = await restarted.getSnapshot(conversation.id);
    expect(snap?.messages.some((row) => row.content.includes('ORPHEUS-731'))).toBe(true);
  });

  it('includes compiled history in the routing token estimate', async () => {
    const stores = memoryStores();
    const seen: number[] = [];
    const runtime = new ConversationRuntime({
      conversations: stores.conversations,
      messages: stores.messages,
      executions: stores.executions,
      provenance: stores.provenance,
      events: new MemoryEventBus(),
      router: {
        resolve: (target, request) => {
          seen.push(request?.contextTokens ?? 0);
          return decision(target, ['mock/atlas']);
        },
      } satisfies CapabilityRouter,
      executor: capturingExecutor([]),
    });
    const conversation = await runtime.createConversation({ title: 'Tokens' });
    const prior = 'ORPHEUS-731 '.repeat(400);
    for await (const _ of runtime.sendMessage(conversation.id, { content: prior })) {
      void _;
    }
    for await (const _ of runtime.sendMessage(conversation.id, { content: "What did I say my dog's name was?" })) {
      void _;
    }
    expect(seen.length).toBeGreaterThanOrEqual(2);
    const first = seen[0] ?? 0;
    const second = seen[1] ?? 0;
    expect(second).toBeGreaterThan(first);
    expect(second).toBeGreaterThan(prior.length / 4);
  });

  it('posts notices as durable assistant messages', async () => {
    const stores = memoryStores();
    const runtime = new ConversationRuntime({
      conversations: stores.conversations,
      messages: stores.messages,
      executions: stores.executions,
      provenance: stores.provenance,
      events: new MemoryEventBus(),
      router: { resolve: (target) => decision(target, ['mock/atlas']) },
      executor: capturingExecutor([]),
    });
    const conversation = await runtime.createConversation({ title: 'Notice' });
    const notice = await runtime.postNotice(conversation.id, 'those findings are filed.');
    expect(notice.role).toBe('assistant');
    const snap = await runtime.getSnapshot(conversation.id);
    expect(snap?.messages.some((row) => row.id === notice.id)).toBe(true);
  });
});
