import { describe, expect, it } from 'vitest';
import type { RouteDecision, StreamChunk } from '@atlas-vnext/contracts';
import { MemoryEventBus } from '@atlas-vnext/events';
import {
  ConversationRuntime,
  conversationChannel,
  memoryStores,
  type CapabilityRouter,
  type ModelExecutor,
} from '../src/index.ts';
import { assertExecutionTransition } from '../src/transitions.ts';

function decision(target: string, chain: string[]): RouteDecision {
  const [primary] = chain;
  const [provider, model] = (primary ?? 'openai/gpt-4o').split('/');
  return {
    target,
    resolvedRouteId: primary ?? 'openai/gpt-4o',
    provider: provider ?? 'openai',
    model: model ?? 'gpt-4o',
    candidateChain: chain,
    localOnly: false,
    decisionReason: 'test-route',
    traceId: 'trc_test',
    evaluatedAt: '2026-09-14T00:00:00.000Z',
  };
}

function fakeRouter(resolveImpl: CapabilityRouter['resolve']): CapabilityRouter {
  return { resolve: resolveImpl };
}

function fakeExecutor(stream: (decision: RouteDecision) => AsyncGenerator<StreamChunk>): ModelExecutor {
  return {
    async *execute(decision, _context, observer) {
      const [first] = decision.candidateChain;
      const slash = first?.indexOf('/') ?? -1;
      observer?.onAttempt({
        index: 1,
        provider: first?.slice(0, slash) ?? decision.provider,
        model: first?.slice(slash + 1) ?? decision.model,
        outcome: 'started',
        error: null,
        emittedVisibleOutput: false,
      });
      let visible = false;
      try {
        for await (const chunk of stream(decision)) {
          if (chunk.type === 'text' && chunk.text.length > 0) visible = true;
          yield chunk;
        }
        observer?.onAttempt({
          index: 1,
          provider: decision.provider,
          model: decision.model,
          outcome: 'succeeded',
          error: null,
          emittedVisibleOutput: visible,
        });
        observer?.onSelected?.({ provider: decision.provider, model: decision.model });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        observer?.onAttempt({
          index: 1,
          provider: decision.provider,
          model: decision.model,
          outcome: 'failed',
          error: { code: 'provider_error', message, retryable: !visible, at: '2026-09-14T00:00:00.000Z' },
          emittedVisibleOutput: visible,
        });
        throw err;
      }
    },
  };
}

async function collect(runtime: ConversationRuntime, conversationId: string, content: string, capability = 'nexus/fast') {
  const events = [];
  for await (const event of runtime.sendMessage(conversationId, { content, capability })) {
    events.push(event);
  }
  return events;
}

function harness(overrides?: { router?: CapabilityRouter; executor?: ModelExecutor }) {
  const stores = memoryStores();
  const events = new MemoryEventBus();
  const runtime = new ConversationRuntime({
    conversations: stores.conversations,
    messages: stores.messages,
    executions: stores.executions,
    provenance: stores.provenance,
    events,
    router:
      overrides?.router ??
      fakeRouter((target) => decision(target, target === 'nexus/reason' ? ['anthropic/claude-sonnet'] : ['openai/gpt-4o'])),
    executor:
      overrides?.executor ??
      fakeExecutor(async function* (routed) {
        yield { type: 'text', text: `hello from ${routed.provider}/${routed.model}` };
        yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } };
      }),
  });
  return { runtime, stores, events };
}

describe('conversation persistence and ordering', () => {
  it('creates, lists, and retrieves conversations with stable ids', async () => {
    const { runtime } = harness();
    const created = await runtime.createConversation({ title: 'Spine' });
    expect(created.id.startsWith('cnv_')).toBe(true);
    expect(created.urn.startsWith('urn:atlas:conversation:')).toBe(true);
    expect(await runtime.listConversations()).toEqual([created]);
    const snapshot = await runtime.getSnapshot(created.id);
    expect(snapshot?.conversation.id).toBe(created.id);
    expect(snapshot?.messages).toEqual([]);
  });

  it('persists user and assistant messages in sequence order', async () => {
    const { runtime } = harness();
    const conversation = await runtime.createConversation();
    await collect(runtime, conversation.id, 'first');
    await collect(runtime, conversation.id, 'second');
    const snapshot = await runtime.getSnapshot(conversation.id);
    expect(snapshot?.messages.map((message) => [message.sequence, message.role, message.content])).toEqual([
      [0, 'user', 'first'],
      [1, 'assistant', 'hello from openai/gpt-4o'],
      [2, 'user', 'second'],
      [3, 'assistant', 'hello from openai/gpt-4o'],
    ]);
  });
});

describe('execution lifecycle', () => {
  it('records queued → running → completed with provenance and usage', async () => {
    const { runtime, stores, events } = harness();
    const conversation = await runtime.createConversation();
    const stream = await collect(runtime, conversation.id, 'trace this', 'nexus/fast');
    expect(stream.at(-1)?.type).toBe('done');
    const snapshot = await runtime.getSnapshot(conversation.id);
    const execution = snapshot?.executions[0];
    expect(execution?.status).toBe('completed');
    expect(execution?.capability).toBe('nexus/fast');
    expect(execution?.selectedProvider).toBe('openai');
    expect(execution?.selectedModel).toBe('gpt-4o');
    expect(execution?.usage).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 });
    expect(execution?.route?.resolvedRouteId).toBe('openai/gpt-4o');
    const provenance = await stores.provenance.forJob(execution!.id);
    expect(provenance).toHaveLength(1);
    expect(provenance[0]?.provider).toBe('openai');
    expect(provenance[0]?.model).toBe('gpt-4o');
    const log = await events.history(conversationChannel(conversation.id));
    expect(log.map((item) => item.type)).toContain('execution.routed');
    expect(log.map((item) => item.type)).toContain('execution.completed');
  });

  it('persists routing failure without pretending success', async () => {
    const { runtime } = harness({
      router: fakeRouter(() => {
        throw new Error('No healthy candidates for nexus/reason.');
      }),
    });
    const conversation = await runtime.createConversation();
    const stream = await collect(runtime, conversation.id, 'why', 'nexus/reason');
    expect(stream.some((event) => event.type === 'error')).toBe(true);
    const snapshot = await runtime.getSnapshot(conversation.id);
    expect(snapshot?.executions[0]?.status).toBe('failed');
    expect(snapshot?.executions[0]?.failureReason?.code).toBe('routing_failed');
    expect(snapshot?.messages.map((message) => message.role)).toEqual(['user']);
  });

  it('rejects illegal execution transitions', () => {
    expect(() => assertExecutionTransition('completed', 'running')).toThrow(/Illegal execution transition/);
    expect(() => assertExecutionTransition('queued', 'running')).not.toThrow();
  });
});

describe('Nexus → execution boundary', () => {
  it('resolves a capability then executes that RouteDecision', async () => {
    const resolved = decision('nexus/reason', ['anthropic/claude-sonnet']);
    const seen: string[] = [];
    const { runtime } = harness({
      router: fakeRouter((target) => {
        seen.push(`route:${target}`);
        expect(target).toBe('nexus/reason');
        return resolved;
      }),
      executor: fakeExecutor(async function* (routed) {
        seen.push(`execute:${routed.resolvedRouteId}`);
        expect(routed).toEqual(resolved);
        yield { type: 'text', text: 'reasoned' };
      }),
    });
    const conversation = await runtime.createConversation();
    await collect(runtime, conversation.id, 'think', 'nexus/reason');
    expect(seen).toEqual(['route:nexus/reason', 'execute:anthropic/claude-sonnet']);
    const snapshot = await runtime.getSnapshot(conversation.id);
    expect(snapshot?.executions[0]?.selectedProvider).toBe('anthropic');
    expect(snapshot?.messages.at(-1)?.content).toBe('reasoned');
  });
});

describe('streaming and failure behaviour', () => {
  it('streams assistant output as deltas', async () => {
    const { runtime } = harness({
      executor: fakeExecutor(async function* () {
        yield { type: 'text', text: 'Hel' };
        yield { type: 'text', text: 'lo' };
      }),
    });
    const conversation = await runtime.createConversation();
    const stream = await collect(runtime, conversation.id, 'hi');
    const deltas = stream.filter((event) => event.type === 'message.delta');
    expect(deltas.map((event) => (event.type === 'message.delta' ? event.content : ''))).toEqual(['Hel', 'Hello']);
  });

  it('allows executor-level fallback before visible output', async () => {
    const { runtime } = harness({
      router: fakeRouter(() => decision('nexus/fast', ['openai/gpt-4o', 'ollama/llama3.2'])),
      executor: {
        async *execute(routed, _ctx, observer) {
          observer?.onAttempt({
            index: 1,
            provider: 'openai',
            model: 'gpt-4o',
            outcome: 'failed',
            error: { code: 'timeout', message: 'timeout before tokens', retryable: true, at: '2026-09-14T00:00:00.000Z' },
            emittedVisibleOutput: false,
          });
          observer?.onAttempt({
            index: 2,
            provider: 'ollama',
            model: 'llama3.2',
            outcome: 'started',
            error: null,
            emittedVisibleOutput: false,
          });
          yield { type: 'text', text: 'recovered locally' };
          observer?.onAttempt({
            index: 2,
            provider: 'ollama',
            model: 'llama3.2',
            outcome: 'succeeded',
            error: null,
            emittedVisibleOutput: true,
          });
          observer?.onSelected?.({ provider: 'ollama', model: 'llama3.2' });
          expect(routed.candidateChain).toEqual(['openai/gpt-4o', 'ollama/llama3.2']);
        },
      },
    });
    const conversation = await runtime.createConversation();
    await collect(runtime, conversation.id, 'hello');
    const snapshot = await runtime.getSnapshot(conversation.id);
    expect(snapshot?.executions[0]?.status).toBe('completed');
    expect(snapshot?.executions[0]?.selectedProvider).toBe('ollama');
    expect(snapshot?.executions[0]?.attempts.map((attempt) => attempt.outcome)).toEqual(['failed', 'succeeded']);
    expect(snapshot?.messages.at(-1)?.content).toBe('recovered locally');
  });

  it('does not Frankenstein a second model after partial assistant output', async () => {
    const { runtime } = harness({
      executor: {
        async *execute(_routed, _ctx, observer) {
          observer?.onAttempt({
            index: 1,
            provider: 'openai',
            model: 'gpt-4o',
            outcome: 'started',
            error: null,
            emittedVisibleOutput: false,
          });
          yield { type: 'text', text: 'partial answer' };
          observer?.onAttempt({
            index: 1,
            provider: 'openai',
            model: 'gpt-4o',
            outcome: 'failed',
            error: { code: 'cut', message: 'cut after tokens', retryable: false, at: '2026-09-14T00:00:00.000Z' },
            emittedVisibleOutput: true,
          });
          throw new Error('cut after tokens');
        },
      },
    });
    const conversation = await runtime.createConversation();
    const stream = await collect(runtime, conversation.id, 'write');
    expect(stream.some((event) => event.type === 'error')).toBe(true);
    const snapshot = await runtime.getSnapshot(conversation.id);
    expect(snapshot?.executions[0]?.status).toBe('failed');
    expect(snapshot?.executions[0]?.failureReason?.code).toBe('partial_stream_failure');
    expect(snapshot?.messages.at(-1)?.content).toBe('partial answer');
    expect(snapshot?.executions[0]?.attempts.some((attempt) => attempt.emittedVisibleOutput)).toBe(true);
  });

  it('emits normalised execution events around a successful turn', async () => {
    const { runtime } = harness();
    const conversation = await runtime.createConversation();
    const stream = await collect(runtime, conversation.id, 'events');
    const types = stream.map((event) => event.type);
    expect(types).toContain('execution.started');
    expect(types).toContain('attempt.started');
    expect(types).toContain('assistant.delta');
    expect(types).toContain('assistant.completed');
    expect(types).toContain('usage');
    expect(types).toContain('execution.completed');
    expect(types.at(-1)).toBe('done');
  });
});
