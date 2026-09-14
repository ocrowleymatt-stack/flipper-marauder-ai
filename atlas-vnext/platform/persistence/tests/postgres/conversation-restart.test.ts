import { afterEach, describe, expect, it } from 'vitest';
import type { RouteDecision, StreamChunk } from '@atlas-vnext/contracts';
import { ConversationRuntime, type ModelExecutor } from '@atlas-vnext/conversation';
import { openPostgresPersistence, type PostgresPersistence } from '../../src/postgres/kernel.ts';
import { openTestKernel, persistenceConfig, postgresUrl, tenantA } from './harness.ts';
import { assertIdent } from '../../src/postgres/tx.ts';
import pg from 'pg';

const { Pool } = pg;
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
    traceId: 'trc_pg',
    evaluatedAt: '2026-09-14T00:00:00.000Z',
  };
}

function executor(text = 'durable hello'): ModelExecutor {
  return {
    async *execute(_decision, _ctx, observer): AsyncGenerator<StreamChunk> {
      observer?.onAttempt({
        index: 1,
        provider: 'openai',
        model: 'gpt-4o',
        outcome: 'started',
        error: null,
        emittedVisibleOutput: false,
      });
      yield { type: 'text', text };
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
}

function runtimeFor(kernel: PostgresPersistence): ConversationRuntime {
  const bound = kernel.forActor(tenantA);
  return new ConversationRuntime({
    conversations: bound.conversations,
    messages: bound.messages,
    executions: bound.executions,
    provenance: bound.provenance,
    events: bound.events,
    router: { resolve: () => decision() },
    executor: executor(),
    unitOfWork: kernel,
  });
}

describe('conversation persistence across restart', () => {
  it('replays the full create/message/execute sequence on fresh service objects', async () => {
    const handle = await openTestKernel();
    const schema = handle.schema;
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const firstRuntime = runtimeFor(handle.kernel);
    const conversation = await firstRuntime.createConversation({ title: 'Keep me' });
    for await (const _event of firstRuntime.sendMessage(conversation.id, { content: 'ping', capability: 'nexus/fast' })) {
      // drain
    }
    const eventsBefore = await handle.kernel.forActor(tenantA).events.history(`conversation:${conversation.id}`);
    await handle.kernel.close();

    const reopened = await openPostgresPersistence(persistenceConfig(schema));
    cleanups.push(async () => {
      await reopened.close();
      const cleanup = new Pool({ connectionString: postgresUrl() });
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS ${assertIdent(schema)} CASCADE`);
      } finally {
        await cleanup.end();
      }
    });
    const recoveredRuntime = runtimeFor(reopened);
    const recovered = await recoveredRuntime.recoverInFlight();
    expect(recovered).toEqual([]);
    const snapshot = await recoveredRuntime.getSnapshot(conversation.id);
    expect(snapshot?.conversation.title).toBe('Keep me');
    expect(snapshot?.messages.map((message) => message.content)).toEqual(['ping', 'durable hello']);
    expect(snapshot?.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(snapshot?.executions[0]?.status).toBe('completed');
    const eventsAfter = await reopened.forActor(tenantA).events.history(`conversation:${conversation.id}`);
    expect(eventsAfter.map((event) => event.type)).toEqual(eventsBefore.map((event) => event.type));
    expect(eventsAfter.some((event) => event.type === 'execution.completed')).toBe(true);
    expect(eventsAfter.map((event) => event.seq)).toEqual(
      [...eventsAfter].sort((a, b) => a.seq - b.seq).map((event) => event.seq),
    );
  });

  it('fails in-flight executions after process death without duplicating assistant messages', async () => {
    const handle = await openTestKernel();
    const schema = handle.schema;
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    const bound = handle.kernel.forActor(tenantA);
    const conversation = await bound.conversations.create({ title: 'Open', projectId: null });
    const user = await bound.messages.append({
      conversationId: conversation.id,
      role: 'user',
      content: 'hang',
      executionId: null,
    });
    const assistant = await bound.messages.append({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'partial',
      executionId: 'exe_stuck',
    });
    await bound.executions.create({
      id: 'exe_stuck',
      urn: 'urn:atlas:execution:stuck',
      conversationId: conversation.id,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      tenantId: tenantA.tenantId,
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
    await bound.events.publish({
      channel: `conversation:${conversation.id}`,
      type: 'message.appended',
      payload: { messageId: assistant.id, role: 'assistant' },
      conversationId: conversation.id,
    });
    await handle.kernel.close();

    const reopened = await openPostgresPersistence(persistenceConfig(schema));
    cleanups.push(async () => {
      await reopened.close();
      const cleanup = new Pool({ connectionString: postgresUrl() });
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS ${assertIdent(schema)} CASCADE`);
      } finally {
        await cleanup.end();
      }
    });
    const recovery = await reopened.recoverOnStart();
    expect(recovery.executions).toHaveLength(1);
    expect(recovery.executions[0]?.status).toBe('failed');
    expect(recovery.executions[0]?.failureReason?.code).toBe('interrupted');
    const snapshot = await runtimeFor(reopened).getSnapshot(conversation.id);
    expect(snapshot?.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(snapshot?.messages.map((message) => message.content)).toEqual(['hang', 'partial']);
    const events = await reopened.forActor(tenantA).events.history(`conversation:${conversation.id}`);
    expect(events.some((event) => event.type === 'execution.failed')).toBe(true);
    expect(events.filter((event) => event.type === 'message.appended' && (event.payload as { role?: string }).role === 'assistant')).toHaveLength(1);
  });
});
