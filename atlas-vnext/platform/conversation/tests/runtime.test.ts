import { describe, expect, it } from 'vitest';
import type { RouteDecision, StreamChunk } from '@atlas-vnext/contracts';
import { MemoryEventBus } from '@atlas-vnext/events';
import {
  ConversationRuntime,
  conversationChannel,
  memoryStores,
  STREAM_PERSIST_CHECKPOINT_BYTES,
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
    locality: 'public_cloud',
    runtimeClass: 'always_available',
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

function harness(overrides?: {
  router?: CapabilityRouter;
  executor?: ModelExecutor;
  maxConcurrentExecutions?: number;
  maxGeneratedBytes?: number;
}) {
  const stores = memoryStores();
  const events = new MemoryEventBus();
  const runtime = new ConversationRuntime({
    conversations: stores.conversations,
    messages: stores.messages,
    executions: stores.executions,
    provenance: stores.provenance,
    events,
    maxConcurrentExecutions: overrides?.maxConcurrentExecutions,
    maxGeneratedBytes: overrides?.maxGeneratedBytes,
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
    expect(deltas.map((event) => (event.type === 'message.delta' ? event.content : ''))).toEqual(['Hel', 'lo']);
    const assistantDeltas = stream.filter((event) => event.type === 'assistant.delta');
    expect(assistantDeltas.map((event) => (event.type === 'assistant.delta' ? event.text : ''))).toEqual(['Hel', 'lo']);
    expect(stream.find((event) => event.type === 'assistant.completed')).toMatchObject({ text: 'Hello' });
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

  it('mountain-compat: does not Frankenstein a second model after partial assistant output', async () => {
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

  it('forwards systemPrompt and routing requirements to the executor', async () => {
    let seenSystem = '';
    let seenPrompt = '';
    let routedTarget = '';
    const { runtime } = harness({
      router: fakeRouter((target) => {
        routedTarget = target;
        return decision(target, ['mock/mock-fast']);
      }),
      executor: {
        async *execute(_decision, context) {
          seenSystem = context.systemPrompt ?? '';
          seenPrompt = context.prompt;
          yield { type: 'text', text: 'ok' };
        },
      },
    });
    const conversation = await runtime.createConversation();
    await collectEvents(runtime, conversation.id);
    expect(routedTarget).toBe('nexus/reason');
    expect(seenSystem).toContain('capability policy');
    expect(seenPrompt).toContain('user instruction');
  });
});

describe('generated output byte ceiling', () => {
  function limitedHarness(limit: number, stream: () => AsyncGenerator<StreamChunk>) {
    const stores = memoryStores();
    const events = new MemoryEventBus();
    const runtime = new ConversationRuntime({
      conversations: stores.conversations,
      messages: stores.messages,
      executions: stores.executions,
      provenance: stores.provenance,
      events,
      maxGeneratedBytes: limit,
      router: fakeRouter((target) => decision(target, ['openai/gpt-4o'])),
      executor: fakeExecutor(stream),
    });
    return { runtime, stores };
  }

  it('accepts output below the configured UTF-8 byte limit', async () => {
    const { runtime, stores } = limitedHarness(16, async function* () {
      yield { type: 'text', text: 'hello' };
    });
    const conversation = await runtime.createConversation();
    const stream = await collect(runtime, conversation.id, 'hi');
    expect(stream.some((event) => event.type === 'done')).toBe(true);
    expect(stream.some((event) => event.type === 'error')).toBe(false);
    expect(Buffer.byteLength('hello', 'utf8')).toBeLessThan(16);
    expect((await stores.messages.list(conversation.id)).at(-1)?.content).toBe('hello');
  });

  it('accepts output that lands exactly on the UTF-8 byte limit', async () => {
    const { runtime, stores } = limitedHarness(5, async function* () {
      yield { type: 'text', text: 'hello' };
    });
    const conversation = await runtime.createConversation();
    const stream = await collect(runtime, conversation.id, 'hi');
    expect(stream.some((event) => event.type === 'error')).toBe(false);
    expect((await stores.messages.list(conversation.id)).at(-1)?.content).toBe('hello');
  });

  it('rejects the chunk that would exceed the limit by one byte and does not persist it', async () => {
    const { runtime, stores } = limitedHarness(5, async function* () {
      yield { type: 'text', text: 'hello!' };
    });
    const conversation = await runtime.createConversation();
    const stream = await collect(runtime, conversation.id, 'hi');
    const error = stream.find((event) => event.type === 'error');
    expect(error).toMatchObject({ type: 'error', failure: { code: 'payload_too_large', retryable: false } });
    expect(stream.some((event) => event.type === 'done')).toBe(true);
    const messages = await stores.messages.list(conversation.id);
    expect(messages.map((message) => message.role)).toEqual(['user']);
    const snapshot = await runtime.getSnapshot(conversation.id);
    expect(snapshot?.executions[0]?.failureReason?.code).toBe('payload_too_large');
    expect(snapshot?.executions[0]?.status).toBe('failed');
  });

  it('enforces the ceiling across many small chunks', async () => {
    const { runtime, stores } = limitedHarness(4, async function* () {
      yield { type: 'text', text: 'ab' };
      yield { type: 'text', text: 'cd' };
      yield { type: 'text', text: 'e' };
    });
    const conversation = await runtime.createConversation();
    const stream = await collect(runtime, conversation.id, 'hi');
    expect(stream.some((event) => event.type === 'error')).toBe(true);
    expect((await stores.messages.list(conversation.id)).at(-1)?.content).toBe('abcd');
  });

  it('counts multibyte UTF-8 rather than JavaScript string length', async () => {
    const euro = '€';
    expect(euro.length).toBe(1);
    expect(Buffer.byteLength(euro, 'utf8')).toBe(3);
    const { runtime, stores } = limitedHarness(2, async function* () {
      yield { type: 'text', text: euro };
    });
    const conversation = await runtime.createConversation();
    const stream = await collect(runtime, conversation.id, 'hi');
    expect(stream.find((event) => event.type === 'error')).toMatchObject({
      failure: { code: 'payload_too_large' },
    });
    expect((await stores.messages.list(conversation.id)).map((message) => message.role)).toEqual(['user']);
  });

  it('does not switch providers after visible output hits the generated-byte ceiling', async () => {
    const providers: string[] = [];
    const stores = memoryStores();
    const runtime = new ConversationRuntime({
      conversations: stores.conversations,
      messages: stores.messages,
      executions: stores.executions,
      provenance: stores.provenance,
      events: new MemoryEventBus(),
      maxGeneratedBytes: 4,
      router: fakeRouter(() => decision('nexus/fast', ['openai/gpt-4o', 'ollama/llama3.2'])),
      executor: {
        async *execute(routed, _ctx, observer) {
          observer?.onAttempt({
            index: 1,
            provider: 'openai',
            model: 'gpt-4o',
            outcome: 'started',
            error: null,
            emittedVisibleOutput: false,
          });
          providers.push(routed.provider);
          yield { type: 'text', text: 'abcd' };
          yield { type: 'text', text: 'e' };
          observer?.onAttempt({
            index: 1,
            provider: 'openai',
            model: 'gpt-4o',
            outcome: 'failed',
            error: { code: 'provider_error', message: 'should not failover', retryable: true, at: '2026-09-14T00:00:00.000Z' },
            emittedVisibleOutput: true,
          });
          observer?.onAttempt({
            index: 2,
            provider: 'ollama',
            model: 'llama3.2',
            outcome: 'started',
            error: null,
            emittedVisibleOutput: false,
          });
          providers.push('ollama');
          yield { type: 'text', text: 'switched' };
        },
      },
    });
    const conversation = await runtime.createConversation();
    const stream = await collect(runtime, conversation.id, 'hi');
    expect(providers).toEqual(['openai']);
    expect(stream.find((event) => event.type === 'error')).toMatchObject({
      failure: { code: 'payload_too_large' },
    });
    expect((await stores.messages.list(conversation.id)).at(-1)?.content).toBe('abcd');
    expect((await runtime.getSnapshot(conversation.id))?.executions[0]?.failureReason?.code).toBe('payload_too_large');
  });
});

describe('true-delta streaming, bounded persistence, and abort teardown', () => {
  it('emits incremental deltas and persists the exact final assistant text once at the end for tiny chunks', async () => {
    const stores = memoryStores();
    const savePayloads: string[] = [];
    const originalSave = stores.messages.save.bind(stores.messages);
    stores.messages.save = async (message) => {
      savePayloads.push(message.content);
      return originalSave(message);
    };
    const chunkCount = 5_000;
    const runtime = new ConversationRuntime({
      conversations: stores.conversations,
      messages: stores.messages,
      executions: stores.executions,
      provenance: stores.provenance,
      events: new MemoryEventBus(),
      router: fakeRouter(() => decision('nexus/fast', ['openai/gpt-4o'])),
      executor: fakeExecutor(async function* () {
        for (let i = 0; i < chunkCount; i += 1) yield { type: 'text', text: 'x' };
      }),
    });
    const conversation = await runtime.createConversation();
    const stream = await collect(runtime, conversation.id, 'tiny');
    const deltas = stream.filter((event) => event.type === 'assistant.delta');
    const messageDeltas = stream.filter((event) => event.type === 'message.delta');
    expect(deltas).toHaveLength(chunkCount);
    expect(messageDeltas).toHaveLength(chunkCount);
    expect(deltas.every((event) => event.type === 'assistant.delta' && event.text === 'x')).toBe(true);
    expect(messageDeltas.every((event) => event.type === 'message.delta' && event.content === 'x')).toBe(true);
    const assembled = deltas.map((event) => (event.type === 'assistant.delta' ? event.text : '')).join('');
    expect(assembled).toBe('x'.repeat(chunkCount));
    expect(stream.find((event) => event.type === 'assistant.completed')).toMatchObject({ text: assembled });
    expect((await stores.messages.list(conversation.id)).at(-1)?.content).toBe(assembled);
    expect(savePayloads.length).toBeLessThan(Math.ceil(chunkCount / STREAM_PERSIST_CHECKPOINT_BYTES) + 2);
    const persistedChars = savePayloads.reduce((sum, text) => sum + text.length, 0);
    expect(persistedChars).toBeLessThan(chunkCount * 3);
    expect(persistedChars).toBeGreaterThanOrEqual(chunkCount);
  });

  it('does not persist every prefix while still checkpointing a long stream', async () => {
    const stores = memoryStores();
    let saveCalls = 0;
    const originalSave = stores.messages.save.bind(stores.messages);
    stores.messages.save = async (message) => {
      saveCalls += 1;
      return originalSave(message);
    };
    const bytes = STREAM_PERSIST_CHECKPOINT_BYTES * 3 + 10;
    const runtime = new ConversationRuntime({
      conversations: stores.conversations,
      messages: stores.messages,
      executions: stores.executions,
      provenance: stores.provenance,
      events: new MemoryEventBus(),
      router: fakeRouter(() => decision('nexus/fast', ['openai/gpt-4o'])),
      executor: fakeExecutor(async function* () {
        for (let i = 0; i < bytes; i += 1) yield { type: 'text', text: 'y' };
      }),
    });
    const conversation = await runtime.createConversation();
    await collect(runtime, conversation.id, 'checkpoint');
    expect((await stores.messages.list(conversation.id)).at(-1)?.content).toBe('y'.repeat(bytes));
    expect(saveCalls).toBeGreaterThanOrEqual(3);
    expect(saveCalls).toBeLessThan(bytes / 10);
  });

  it('treats cancellation after visible output as terminal and does not fail over', async () => {
    const providers: string[] = [];
    const { runtime, stores } = harness({
      router: fakeRouter(() => decision('nexus/fast', ['openai/gpt-4o', 'ollama/llama3.2'])),
      executor: {
        async *execute(routed, context, observer) {
          providers.push(routed.provider);
          observer?.onAttempt({
            index: 1,
            provider: routed.provider,
            model: routed.model,
            outcome: 'started',
            error: null,
            emittedVisibleOutput: false,
          });
          yield { type: 'text', text: 'first tokens' };
          await new Promise<void>((resolve, reject) => {
            if (context.signal?.aborted) {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              return;
            }
            context.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          observer?.onAttempt({
            index: 2,
            provider: 'ollama',
            model: 'llama3.2',
            outcome: 'started',
            error: null,
            emittedVisibleOutput: false,
          });
          providers.push('ollama');
          yield { type: 'text', text: 'switched' };
        },
      },
    });
    const conversation = await runtime.createConversation();
    const gen = runtime.sendMessage(conversation.id, { content: 'cancel after visible' });
    let executionId: string | undefined;
    for (;;) {
      const { value, done } = await gen.next();
      if (done || !value) break;
      if (value.type === 'execution' && value.execution.id) executionId = value.execution.id;
      if (value.type === 'assistant.delta') break;
    }
    await runtime.cancel(executionId!);
    const rest = [];
    for (;;) {
      const { value, done } = await gen.next();
      if (done) break;
      if (value) rest.push(value);
    }
    expect(providers).toEqual(['openai']);
    expect((await runtime.getSnapshot(conversation.id))?.executions[0]?.status).toBe('cancelled');
    expect((await stores.messages.list(conversation.id)).at(-1)?.content).toBe('first tokens');
    expect(rest.some((event) => event.type === 'assistant.delta' && event.text === 'switched')).toBe(false);
  });
});

async function collectEvents(runtime: ConversationRuntime, conversationId: string) {
  const events = [];
  for await (const event of runtime.sendMessage(conversationId, {
    content: 'user instruction',
    systemPrompt: 'capability policy',
    capability: 'nexus/reason',
    requireReasoning: true,
    contextTokens: 4096,
  })) {
    events.push(event);
  }
  return events;
}
