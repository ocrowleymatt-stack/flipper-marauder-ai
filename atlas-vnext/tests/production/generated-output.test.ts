import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationRuntime } from '@atlas-vnext/conversation';
import { authHeaders, bootstrap, readSse, startProductionHost } from './harness.ts';

const servers: Server[] = [];
const spines: Array<{ close: () => Promise<void> }> = [];
const hangReleases: Array<() => void> = [];

afterEach(async () => {
  while (hangReleases.length) hangReleases.pop()?.();
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

async function startLimitedHost(maxGeneratedBytes: string, extra: Record<string, string> = {}) {
  const started = await startProductionHost({
    streamDelayMs: 5,
    env: { ATLAS_MAX_GENERATED_BYTES: maxGeneratedBytes, ...extra },
  });
  servers.push(started.server);
  spines.push(started.spine);
  return started;
}

async function openMessageStream(
  url: string,
  content: string,
  extra?: { signal?: AbortSignal },
) {
  const session = await bootstrap(url);
  const created = await fetch(`${url}/api/conversations`, {
    method: 'POST',
    headers: authHeaders(session),
    body: JSON.stringify({}),
  });
  const conversation = (await created.json()) as { id: string };
  const stream = await fetch(`${url}/api/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: authHeaders(session),
    body: JSON.stringify({ content, capability: 'nexus/fast' }),
    signal: extra?.signal,
  });
  return { session, conversation, stream };
}

describe('P1: ATLAS_MAX_GENERATED_BYTES bounds streamed output', () => {
  it('allows a short reply below the configured ceiling', async () => {
    const started = await startLimitedHost('2000');
    const { stream } = await openMessageStream(started.url, 'short');
    const frames = await readSse(stream);
    expect(frames.some((frame) => frame.event === 'done')).toBe(true);
    expect(frames.some((frame) => frame.event === 'error')).toBe(false);
    expect(started.spine.resources.occupancy(started.spine.tenantId)).toEqual({ streams: 0, runs: 0 });
  });

  it('accepts output that lands exactly on the UTF-8 byte limit', async () => {
    const started = await startLimitedHost('4');
    started.spine.runtime.sendMessage = (async function* () {
      yield { type: 'execution', execution: { id: 'ex_exact', status: 'running' } } as never;
      yield { type: 'assistant.delta', executionId: 'ex_exact', text: 'abcd' } as never;
      yield { type: 'done' } as never;
    }) as ConversationRuntime['sendMessage'];
    const { stream } = await openMessageStream(started.url, 'exact');
    const frames = await readSse(stream);
    expect(frames.some((frame) => frame.event === 'assistant.delta')).toBe(true);
    expect(frames.some((frame) => frame.event === 'error')).toBe(false);
    expect(started.spine.resources.occupancy(started.spine.tenantId)).toEqual({ streams: 0, runs: 0 });
  });

  it('stops before writing a chunk that would exceed the limit by one byte', async () => {
    const started = await startLimitedHost('4');
    started.spine.runtime.sendMessage = (async function* () {
      yield { type: 'execution', execution: { id: 'ex_over', status: 'running' } } as never;
      yield { type: 'assistant.delta', executionId: 'ex_over', text: 'abcde' } as never;
      yield { type: 'done' } as never;
    }) as ConversationRuntime['sendMessage'];
    const { stream } = await openMessageStream(started.url, 'over');
    const frames = await readSse(stream);
    expect(frames.some((frame) => frame.event === 'assistant.delta')).toBe(false);
    const error = frames.find((frame) => frame.event === 'error')?.data as { failure?: { code?: string } };
    expect(error.failure?.code).toBe('payload_too_large');
    expect(started.spine.resources.occupancy(started.spine.tenantId)).toEqual({ streams: 0, runs: 0 });
  });

  it('enforces the ceiling across many small cumulative chunks', async () => {
    const started = await startLimitedHost('4');
    started.spine.runtime.sendMessage = (async function* () {
      yield { type: 'execution', execution: { id: 'ex_small', status: 'running' } } as never;
      yield { type: 'assistant.delta', executionId: 'ex_small', text: 'ab' } as never;
      yield { type: 'assistant.delta', executionId: 'ex_small', text: 'c' } as never;
      yield { type: 'assistant.delta', executionId: 'ex_small', text: 'd' } as never;
      yield { type: 'assistant.delta', executionId: 'ex_small', text: 'e' } as never;
      yield { type: 'done' } as never;
    }) as ConversationRuntime['sendMessage'];
    const { stream } = await openMessageStream(started.url, 'chunks');
    const frames = await readSse(stream);
    const deltas = frames.filter((frame) => frame.event === 'assistant.delta');
    expect(deltas).toHaveLength(3);
    expect((deltas.at(-1)?.data as { text?: string }).text).toBe('d');
    expect(frames.find((frame) => frame.event === 'error')?.data).toMatchObject({
      failure: { code: 'payload_too_large' },
    });
    expect(started.spine.resources.occupancy(started.spine.tenantId)).toEqual({ streams: 0, runs: 0 });
  });

  it('rejects a multibyte character that would cross the UTF-8 boundary', async () => {
    const started = await startLimitedHost('2');
    started.spine.runtime.sendMessage = (async function* () {
      yield { type: 'execution', execution: { id: 'ex_utf8', status: 'running' } } as never;
      yield { type: 'assistant.delta', executionId: 'ex_utf8', text: '€' } as never;
      yield { type: 'done' } as never;
    }) as ConversationRuntime['sendMessage'];
    const { stream } = await openMessageStream(started.url, 'unicode');
    const frames = await readSse(stream);
    expect(frames.some((frame) => frame.event === 'assistant.delta')).toBe(false);
    expect(frames.find((frame) => frame.event === 'error')?.data).toMatchObject({
      failure: { code: 'payload_too_large' },
    });
  });

  it('terminates a runaway provider and restores permits once', async () => {
    const started = await startLimitedHost('8');
    let continued = 0;
    started.spine.runtime.sendMessage = (async function* () {
      yield { type: 'execution', execution: { id: 'ex_runaway', status: 'running' } } as never;
      for (let i = 0; i < 10_000; i += 1) {
        continued = i;
        yield { type: 'assistant.delta', executionId: 'ex_runaway', text: 'x' } as never;
      }
    }) as ConversationRuntime['sendMessage'];
    const { stream } = await openMessageStream(started.url, 'runaway');
    const frames = await readSse(stream);
    expect(frames.find((frame) => frame.event === 'error')?.data).toMatchObject({
      failure: { code: 'payload_too_large' },
    });
    expect(continued).toBeLessThan(100);
    expect(started.spine.resources.occupancy(started.spine.tenantId)).toEqual({ streams: 0, runs: 0 });
  });

  it('releases permits once when cancellation races the generated-byte ceiling', async () => {
    const started = await startLimitedHost('8');
    const cancelled: string[] = [];
    const originalCancel = started.spine.runtime.cancel.bind(started.spine.runtime);
    started.spine.runtime.cancel = (async (executionId: string) => {
      cancelled.push(executionId);
      try {
        return await originalCancel(executionId);
      } catch {
        return { id: executionId, status: 'cancelled' } as Awaited<ReturnType<ConversationRuntime['cancel']>>;
      }
    }) as ConversationRuntime['cancel'];
    started.spine.runtime.sendMessage = ((...args: Parameters<ConversationRuntime['sendMessage']>) => {
      void args;
      return (async function* () {
        yield { type: 'execution', execution: { id: 'ex_limit_cancel', status: 'running' } } as never;
        yield { type: 'assistant.delta', executionId: 'ex_limit_cancel', text: 'abcdefgh' } as never;
        yield { type: 'assistant.delta', executionId: 'ex_limit_cancel', text: 'i' } as never;
        await new Promise<void>((resolve) => hangReleases.push(resolve));
      })();
    }) as ConversationRuntime['sendMessage'];
    const { stream } = await openMessageStream(started.url, 'race-cancel');
    const frames = await readSse(stream);
    hangReleases.pop()?.();
    expect(frames.find((frame) => frame.event === 'error')?.data).toMatchObject({
      failure: { code: 'payload_too_large' },
    });
    expect(cancelled).toEqual(['ex_limit_cancel']);
    expect(started.spine.resources.occupancy(started.spine.tenantId)).toEqual({ streams: 0, runs: 0 });
  });

  it('releases permits once when the client disconnects as the limit is reached', async () => {
    const started = await startLimitedHost('8');
    const cancelled: string[] = [];
    started.spine.runtime.cancel = (async (executionId: string) => {
      cancelled.push(executionId);
      return { id: executionId, status: 'cancelled' } as Awaited<ReturnType<ConversationRuntime['cancel']>>;
    }) as ConversationRuntime['cancel'];
    started.spine.runtime.sendMessage = (async function* () {
      yield { type: 'execution', execution: { id: 'ex_limit_disconnect', status: 'running' } } as never;
      yield { type: 'assistant.delta', executionId: 'ex_limit_disconnect', text: 'abcdefgh' } as never;
      yield { type: 'assistant.delta', executionId: 'ex_limit_disconnect', text: 'i' } as never;
      await new Promise<void>((resolve) => hangReleases.push(resolve));
    }) as ConversationRuntime['sendMessage'];
    const abort = new AbortController();
    const { stream } = await openMessageStream(started.url, 'race-disconnect', { signal: abort.signal });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    abort.abort();
    await reader.cancel().catch(() => undefined);
    await waitForOccupancy(() => started.spine.resources.occupancy(started.spine.tenantId), { streams: 0, runs: 0 });
    hangReleases.pop()?.();
    expect(cancelled.length).toBeGreaterThanOrEqual(1);
    expect(new Set(cancelled).size).toBe(1);
  });

  it('does not let SSE idle timeout fight the generated-byte terminal outcome', async () => {
    const started = await startLimitedHost('4', { ATLAS_STREAM_IDLE_TIMEOUT_MS: '40' });
    started.spine.runtime.sendMessage = (async function* () {
      yield { type: 'execution', execution: { id: 'ex_limit_idle', status: 'running' } } as never;
      yield { type: 'assistant.delta', executionId: 'ex_limit_idle', text: 'abcde' } as never;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }) as ConversationRuntime['sendMessage'];
    const { stream } = await openMessageStream(started.url, 'idle-limit');
    const frames = await readSse(stream);
    const errors = frames.filter((frame) => frame.event === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0]?.data as { failure?: { code?: string } }).failure?.code).toBe('payload_too_large');
    expect(started.spine.resources.occupancy(started.spine.tenantId)).toEqual({ streams: 0, runs: 0 });
  });
});
