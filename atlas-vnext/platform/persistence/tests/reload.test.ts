import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RouteDecision, StreamChunk } from '@atlas-vnext/contracts';
import { ConversationRuntime, type ModelExecutor } from '@atlas-vnext/conversation';
import { openDurableStore } from '../src/index.ts';

function decision(): RouteDecision {
  return {
    target: 'nexus/fast',
    resolvedRouteId: 'openai/gpt-4o',
    provider: 'openai',
    model: 'gpt-4o',
    candidateChain: ['openai/gpt-4o'],
    localOnly: false,
    decisionReason: 'test',
    traceId: 'trc_reload',
    evaluatedAt: '2026-09-14T00:00:00.000Z',
  };
}

const executor: ModelExecutor = {
  async *execute(_decision, _ctx, observer): AsyncGenerator<StreamChunk> {
    observer?.onAttempt({
      index: 1,
      provider: 'openai',
      model: 'gpt-4o',
      outcome: 'started',
      error: null,
      emittedVisibleOutput: false,
    });
    yield { type: 'text', text: 'durable hello' };
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } };
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

describe('durable store reload/recovery', () => {
  it('round-trips conversations, messages, executions, and events across process instances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-vnext-'));
    const file = join(dir, 'state.json');
    const first = openDurableStore(file);
    const runtime = new ConversationRuntime({
      conversations: first.conversations,
      messages: first.messages,
      executions: first.executions,
      provenance: first.provenance,
      events: first.events,
      router: { resolve: () => decision() },
      executor,
    });
    const conversation = await runtime.createConversation({ title: 'Keep me' });
    for await (const _event of runtime.sendMessage(conversation.id, { content: 'ping', capability: 'nexus/fast' })) {
      // drain
    }

    const reopened = openDurableStore(file);
    const recovered = new ConversationRuntime({
      conversations: reopened.conversations,
      messages: reopened.messages,
      executions: reopened.executions,
      provenance: reopened.provenance,
      events: reopened.events,
      router: { resolve: () => decision() },
      executor,
    });
    const snapshot = await recovered.getSnapshot(conversation.id);
    expect(snapshot?.conversation.title).toBe('Keep me');
    expect(snapshot?.messages.map((message) => message.content)).toEqual(['ping', 'durable hello']);
    expect(snapshot?.executions[0]?.status).toBe('completed');
    expect(snapshot?.executions[0]?.selectedProvider).toBe('openai');
    const provenance = await reopened.provenance.forJob(snapshot!.executions[0]!.id);
    expect(provenance[0]?.model).toBe('gpt-4o');
    const events = await reopened.events.history(`conversation:${conversation.id}`);
    expect(events.some((event) => event.type === 'execution.completed')).toBe(true);
  });

  it('fails in-flight executions after a restart so they are not silently running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-vnext-'));
    const file = join(dir, 'state.json');
    const first = openDurableStore(file);
    const conversation = await first.conversations.create({ title: 'Open', projectId: null });
    const user = await first.messages.append({
      conversationId: conversation.id,
      role: 'user',
      content: 'hang',
      executionId: null,
    });
    await first.executions.create({
      id: 'exe_stuck',
      urn: 'urn:atlas:execution:stuck',
      conversationId: conversation.id,
      userMessageId: user.id,
      assistantMessageId: null,
      status: 'running',
      capability: 'nexus/fast',
      route: decision(),
      selectedProvider: 'openai',
      selectedModel: 'gpt-4o',
      attempts: [],
      usage: null,
      failureReason: null,
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
      startedAt: '2026-09-14T00:00:00.000Z',
      completedAt: null,
    });

    const reopened = openDurableStore(file);
    const runtime = new ConversationRuntime({
      conversations: reopened.conversations,
      messages: reopened.messages,
      executions: reopened.executions,
      provenance: reopened.provenance,
      events: reopened.events,
      router: { resolve: () => decision() },
      executor,
    });
    const recovered = await runtime.recoverInFlight();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe('failed');
    expect(recovered[0]?.failureReason?.code).toBe('interrupted');
    const snapshot = await runtime.getSnapshot(conversation.id);
    expect(snapshot?.executions[0]?.status).toBe('failed');
    expect(snapshot?.messages.map((message) => message.role)).toEqual(['user']);
  });
});
