import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationRuntime } from '@atlas-vnext/conversation';
import { authHeaders, bootstrap, readSse, startProductionHost } from './harness.ts';

const servers: Server[] = [];
const spines: Array<{ close: () => Promise<void>; runtime: ConversationRuntime; resources: { occupancy: (tenantId: string) => { streams: number; runs: number } }; tenantId: string }> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
  await Promise.all(spines.splice(0).map((spine) => spine.close().catch(() => undefined)));
});

async function waitForOccupancy(
  occupancy: () => { streams: number; runs: number },
  expected: { streams: number; runs: number },
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (JSON.stringify(occupancy()) === JSON.stringify(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  expect(occupancy()).toEqual(expected);
}

async function openConversation(url: string) {
  const session = await bootstrap(url);
  const created = await fetch(`${url}/api/conversations`, {
    method: 'POST',
    headers: authHeaders(session),
    body: JSON.stringify({}),
  });
  const conversation = (await created.json()) as { id: string };
  return { session, conversation };
}

function ignoreAbortIterable(
  executionId: string,
  options: { extraEvents?: Array<{ type: string; [key: string]: unknown }>; hangReturn?: boolean } = {},
) {
  const hooks = { nextPending: 0, returns: 0 };
  const iterable = {
    [Symbol.asyncIterator]() {
      let step = 0;
      const extras = options.extraEvents ?? [];
      return {
        async next() {
          if (step === 0) {
            step += 1;
            return { done: false, value: { type: 'execution', execution: { id: executionId, status: 'running' } } };
          }
          if (step <= extras.length) {
            const event = extras[step - 1];
            step += 1;
            return { done: false, value: event };
          }
          hooks.nextPending += 1;
          await new Promise(() => undefined);
          return { done: true, value: undefined };
        },
        async return() {
          hooks.returns += 1;
          if (options.hangReturn) await new Promise(() => undefined);
          return { done: true, value: undefined };
        },
      };
    },
  };
  return { iterable, hooks };
}

describe('P1: SSE iterator teardown against non-cooperative providers', () => {
  it('calls iterator.return on idle timeout even when next() is pending and abort is ignored', async () => {
    const started = await startProductionHost({ env: { ATLAS_STREAM_IDLE_TIMEOUT_MS: '40' } });
    servers.push(started.server);
    spines.push(started.spine);
    const { iterable, hooks } = ignoreAbortIterable('ex_idle_ignore', { hangReturn: true });
    started.spine.runtime.sendMessage = (() => iterable) as unknown as ConversationRuntime['sendMessage'];
    const { session, conversation } = await openConversation(started.url);
    const startedAt = Date.now();
    const stream = await fetch(`${started.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ content: 'idle ignore abort', capability: 'nexus/fast' }),
    });
    const frames = await readSse(stream);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(hooks.nextPending).toBeGreaterThanOrEqual(1);
    expect(hooks.returns).toBe(1);
    expect(frames.some((frame) => frame.event === 'error')).toBe(true);
    expect((frames.find((frame) => frame.event === 'error')?.data as { failure?: { code?: string } }).failure?.code).toBe(
      'timeout',
    );
    expect(started.spine.resources.occupancy(started.spine.tenantId)).toEqual({ streams: 0, runs: 0 });
  });

  it('calls iterator.return on client disconnect with a pending next()', async () => {
    const started = await startProductionHost();
    servers.push(started.server);
    spines.push(started.spine);
    const { iterable, hooks } = ignoreAbortIterable('ex_disconnect_ignore', { hangReturn: true });
    started.spine.runtime.sendMessage = (() => iterable) as unknown as ConversationRuntime['sendMessage'];
    const { session, conversation } = await openConversation(started.url);
    const abort = new AbortController();
    const stream = await fetch(`${started.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ content: 'disconnect ignore abort', capability: 'nexus/fast' }),
      signal: abort.signal,
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await waitForOccupancy(() => started.spine.resources.occupancy(started.spine.tenantId), { streams: 1, runs: 1 });
    abort.abort();
    await reader.cancel().catch(() => undefined);
    await waitForOccupancy(() => started.spine.resources.occupancy(started.spine.tenantId), { streams: 0, runs: 0 });
    expect(hooks.returns).toBe(1);
  });

  it('calls iterator.return on generated-output termination with a pending next()', async () => {
    const started = await startProductionHost({
      env: { ATLAS_MAX_GENERATED_BYTES: '4' },
    });
    servers.push(started.server);
    spines.push(started.spine);
    const { iterable, hooks } = ignoreAbortIterable('ex_limit_ignore', {
      extraEvents: [{ type: 'assistant.delta', executionId: 'ex_limit_ignore', text: 'abcde' }],
      hangReturn: true,
    });
    started.spine.runtime.sendMessage = (() => iterable) as unknown as ConversationRuntime['sendMessage'];
    const { session, conversation } = await openConversation(started.url);
    const startedAt = Date.now();
    const stream = await fetch(`${started.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ content: 'limit ignore abort', capability: 'nexus/fast' }),
    });
    const frames = await readSse(stream);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(hooks.returns).toBe(1);
    expect((frames.find((frame) => frame.event === 'error')?.data as { failure?: { code?: string } }).failure?.code).toBe(
      'payload_too_large',
    );
    expect(started.spine.resources.occupancy(started.spine.tenantId)).toEqual({ streams: 0, runs: 0 });
  });

  it('teardown is idempotent: idle timeout then disconnect still releases permits once', async () => {
    const started = await startProductionHost({ env: { ATLAS_STREAM_IDLE_TIMEOUT_MS: '40' } });
    servers.push(started.server);
    spines.push(started.spine);
    const { iterable, hooks } = ignoreAbortIterable('ex_repeat', { hangReturn: true });
    started.spine.runtime.sendMessage = (() => iterable) as unknown as ConversationRuntime['sendMessage'];
    const { session, conversation } = await openConversation(started.url);
    const abort = new AbortController();
    const stream = await fetch(`${started.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ content: 'repeat teardown', capability: 'nexus/fast' }),
      signal: abort.signal,
    });
    const frames = await readSse(stream);
    abort.abort();
    expect(hooks.returns).toBe(1);
    expect(frames.filter((frame) => frame.event === 'error')).toHaveLength(1);
    expect(started.spine.resources.occupancy(started.spine.tenantId)).toEqual({ streams: 0, runs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started.spine.resources.occupancy(started.spine.tenantId)).toEqual({ streams: 0, runs: 0 });
  });

  it('clears runtime inflight and in-flight executions when a live provider ignores abort', async () => {
    const started = await startProductionHost({
      env: {
        ATLAS_STREAM_IDLE_TIMEOUT_MS: '50',
        ATLAS_MAX_CONCURRENT_RUNS: '1',
      },
    });
    servers.push(started.server);
    spines.push(started.spine);
    const originalExecute = started.spine.broker.execute.bind(started.spine.broker);
    started.spine.broker.execute = (async function* (_decision, context) {
      yield { type: 'text', text: 'visible' };
      await new Promise(() => {
        void context;
      });
    }) as typeof started.spine.broker.execute;
    const { session, conversation } = await openConversation(started.url);
    const stream = await fetch(`${started.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ content: 'provider ignores abort', capability: 'nexus/fast' }),
    });
    const frames = await readSse(stream);
    expect(frames.some((frame) => frame.event === 'error')).toBe(true);
    const executionId = frames
      .map((frame) => (frame.data as { execution?: { id?: string }; executionId?: string }).execution?.id ?? (frame.data as { executionId?: string }).executionId)
      .find((id): id is string => Boolean(id));
    expect(executionId).toBeTruthy();
    expect(await started.spine.runtime.getExecution(executionId!)).toMatchObject({ status: 'cancelled' });
    expect(started.spine.resources.occupancy(started.spine.tenantId)).toEqual({ streams: 0, runs: 0 });
    started.spine.broker.execute = originalExecute;
    const second = await fetch(`${started.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ content: 'second turn after teardown', capability: 'nexus/fast' }),
    });
    expect(second.status).not.toBe(429);
    const secondFrames = await readSse(second);
    expect(secondFrames.some((frame) => frame.event === 'done' || frame.event === 'error')).toBe(true);
    expect(started.spine.resources.occupancy(started.spine.tenantId)).toEqual({ streams: 0, runs: 0 });
  });
});

describe('P1: true incremental SSE deltas and linear transmission', () => {
  it('transmits thousands of tiny true deltas without quadratic payload growth', async () => {
    const started = await startProductionHost();
    servers.push(started.server);
    spines.push(started.spine);
    const chunks = 3_000;
    started.spine.runtime.sendMessage = (async function* () {
      yield { type: 'execution', execution: { id: 'ex_tiny', status: 'running' } } as never;
      for (let i = 0; i < chunks; i += 1) {
        yield { type: 'assistant.delta', executionId: 'ex_tiny', text: 'x' } as never;
      }
      yield { type: 'assistant.completed', executionId: 'ex_tiny', text: 'x'.repeat(chunks) } as never;
      yield { type: 'done' } as never;
    }) as ConversationRuntime['sendMessage'];
    const { session, conversation } = await openConversation(started.url);
    const stream = await fetch(`${started.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ content: 'tiny chunks', capability: 'nexus/fast' }),
    });
    const frames = await readSse(stream);
    const deltas = frames.filter((frame) => frame.event === 'assistant.delta');
    expect(deltas).toHaveLength(chunks);
    expect(deltas.every((frame) => (frame.data as { text?: string }).text === 'x')).toBe(true);
    const transmitted = deltas.reduce((sum, frame) => sum + String((frame.data as { text?: string }).text ?? '').length, 0);
    expect(transmitted).toBe(chunks);
    expect(transmitted).toBeLessThan(chunks * 2);
    expect((frames.find((frame) => frame.event === 'assistant.completed')?.data as { text?: string }).text).toBe(
      'x'.repeat(chunks),
    );
    expect(frames.some((frame) => frame.event === 'done')).toBe(true);
    expect(started.spine.resources.occupancy(started.spine.tenantId)).toEqual({ streams: 0, runs: 0 });
  });

  it('persists the exact assembled assistant text after a live tiny-chunk stream', async () => {
    const started = await startProductionHost();
    servers.push(started.server);
    spines.push(started.spine);
    const chunks = 2_500;
    started.spine.broker.execute = (async function* () {
      for (let i = 0; i < chunks; i += 1) yield { type: 'text', text: 'z' };
    }) as typeof started.spine.broker.execute;
    const { session, conversation } = await openConversation(started.url);
    const stream = await fetch(`${started.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ content: 'persist tiny', capability: 'nexus/fast' }),
    });
    const frames = await readSse(stream);
    const deltas = frames.filter((frame) => frame.event === 'assistant.delta');
    expect(deltas.length).toBe(chunks);
    expect(deltas.every((frame) => (frame.data as { text?: string }).text === 'z')).toBe(true);
    expect(frames.some((frame) => frame.event === 'done')).toBe(true);
    const snapshot = await started.spine.runtime.getSnapshot(conversation.id);
    expect(snapshot?.messages.at(-1)?.content).toBe('z'.repeat(chunks));
    expect(snapshot?.executions[0]?.status).toBe('completed');
  });
});

async function openDocument(url: string) {
  const session = await bootstrap(url);
  const projectResponse = await fetch(`${url}/api/projects`, {
    method: 'POST',
    headers: authHeaders(session),
    body: JSON.stringify({ name: 'Book', dungeon: 'writing' }),
  });
  const project = (await projectResponse.json()) as { id: string };
  const created = await fetch(`${url}/api/projects/${project.id}/documents`, {
    method: 'POST',
    headers: authHeaders(session),
    body: JSON.stringify({ title: 'Chapter', instruction: 'Write about copper.' }),
  });
  const document = (await created.json()) as { id: string; revision: number };
  return { session, document };
}

function caspaIgnoreAbortIterable(
  executionId: string,
  options: { extraEvents?: Array<{ type: string; [key: string]: unknown }>; hangReturn?: boolean } = {},
) {
  const hooks = { nextPending: 0, returns: 0 };
  const iterable = {
    [Symbol.asyncIterator]() {
      let step = 0;
      const extras = options.extraEvents ?? [];
      return {
        async next() {
          if (step === 0) {
            step += 1;
            return {
              done: false,
              value: {
                type: 'execution',
                event: { type: 'execution', execution: { id: executionId, status: 'running' } },
              },
            };
          }
          if (step <= extras.length) {
            const event = extras[step - 1];
            step += 1;
            return { done: false, value: event };
          }
          hooks.nextPending += 1;
          await new Promise(() => undefined);
          return { done: true, value: undefined };
        },
        async return() {
          hooks.returns += 1;
          if (options.hangReturn) await new Promise(() => undefined);
          return { done: true, value: undefined };
        },
      };
    },
  };
  return { iterable, hooks };
}

describe('P1: Caspa generation uses the same guarded SSE lifecycle', () => {
  it('calls iterator.return on Caspa idle timeout when the provider ignores abort', async () => {
    const started = await startProductionHost({ env: { ATLAS_STREAM_IDLE_TIMEOUT_MS: '40' } });
    servers.push(started.server);
    spines.push(started.spine);
    const { iterable, hooks } = caspaIgnoreAbortIterable('ex_caspa_idle', { hangReturn: true });
    started.spine.writing!.generate = (() => iterable) as unknown as NonNullable<typeof started.spine.writing>['generate'];
    const { session, document } = await openDocument(started.url);
    const startedAt = Date.now();
    const stream = await fetch(`${started.url}/api/documents/${document.id}/generate`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({
        operation: 'create',
        instruction: 'Write about copper.',
        expectedRevision: document.revision,
      }),
    });
    const frames = await readSse(stream);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(hooks.nextPending).toBeGreaterThanOrEqual(1);
    expect(hooks.returns).toBe(1);
    expect((frames.find((frame) => frame.event === 'error')?.data as { failure?: { code?: string } }).failure?.code).toBe(
      'timeout',
    );
    expect(started.spine.resources.occupancy(started.spine.tenantId)).toEqual({ streams: 0, runs: 0 });
  });

  it('calls iterator.return on Caspa client disconnect with a pending next()', async () => {
    const started = await startProductionHost();
    servers.push(started.server);
    spines.push(started.spine);
    const { iterable, hooks } = caspaIgnoreAbortIterable('ex_caspa_disconnect', { hangReturn: true });
    started.spine.writing!.generate = (() => iterable) as unknown as NonNullable<typeof started.spine.writing>['generate'];
    const { session, document } = await openDocument(started.url);
    const abort = new AbortController();
    const stream = await fetch(`${started.url}/api/documents/${document.id}/generate`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({
        operation: 'create',
        instruction: 'Write about copper.',
        expectedRevision: document.revision,
      }),
      signal: abort.signal,
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await waitForOccupancy(() => started.spine.resources.occupancy(started.spine.tenantId), { streams: 1, runs: 1 });
    abort.abort();
    await reader.cancel().catch(() => undefined);
    await waitForOccupancy(() => started.spine.resources.occupancy(started.spine.tenantId), { streams: 0, runs: 0 });
    expect(hooks.returns).toBe(1);
  });

  it('clears runtime inflight and does not commit a Caspa version when a live provider ignores abort', async () => {
    const started = await startProductionHost({
      env: {
        ATLAS_STREAM_IDLE_TIMEOUT_MS: '50',
        ATLAS_MAX_CONCURRENT_RUNS: '1',
      },
    });
    servers.push(started.server);
    spines.push(started.spine);
    const originalExecute = started.spine.broker.execute.bind(started.spine.broker);
    started.spine.broker.execute = (async function* (_decision, context) {
      yield { type: 'text', text: 'visible Caspa paragraph' };
      await new Promise(() => {
        void context;
      });
    }) as typeof started.spine.broker.execute;
    const { session, document } = await openDocument(started.url);
    const stream = await fetch(`${started.url}/api/documents/${document.id}/generate`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({
        operation: 'create',
        instruction: 'Write a visible paragraph.',
        expectedRevision: document.revision,
      }),
    });
    const frames = await readSse(stream);
    expect(frames.some((frame) => frame.event === 'error')).toBe(true);
    expect(frames.some((frame) => frame.event === 'document' && (frame.data as { document?: { status?: string } }).document?.status === 'committed')).toBe(
      false,
    );
    const reloaded = (await (
      await fetch(`${started.url}/api/documents/${document.id}`, { headers: { cookie: session.cookie } })
    ).json()) as { status: string; currentVersion: number; content: string; draft: string | null };
    expect(reloaded.status).toBe('failed');
    expect(reloaded.currentVersion).toBe(0);
    expect(reloaded.content).toBe('');
    expect(reloaded.draft).toContain('visible Caspa paragraph');
    expect(started.spine.resources.occupancy(started.spine.tenantId)).toEqual({ streams: 0, runs: 0 });
    started.spine.broker.execute = originalExecute;
    const retryDoc = await openDocument(started.url);
    const retry = await fetch(`${started.url}/api/documents/${retryDoc.document.id}/generate`, {
      method: 'POST',
      headers: authHeaders(retryDoc.session),
      body: JSON.stringify({
        operation: 'create',
        instruction: 'Write after teardown.',
        expectedRevision: retryDoc.document.revision,
      }),
    });
    expect(retry.status).not.toBe(429);
    const retryFrames = await readSse(retry);
    expect(retryFrames.some((frame) => frame.event === 'done' || frame.event === 'error')).toBe(true);
    expect(started.spine.resources.occupancy(started.spine.tenantId)).toEqual({ streams: 0, runs: 0 });
  });
});

