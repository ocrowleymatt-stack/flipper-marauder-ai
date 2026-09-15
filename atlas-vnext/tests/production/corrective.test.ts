import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ScriptedTransport, responseFromText } from '@atlas-vnext/execution';
import type { ConversationRuntime } from '@atlas-vnext/conversation';
import { composeSpine, createHost, listen, type Spine } from '../../apps/host/src/index.ts';
import { readTimeoutContract } from '../../apps/host/src/production-config.ts';
import { authHeaders, bootstrap, readSse, startProductionHost } from './harness.ts';

const servers: Server[] = [];
const spines: Spine[] = [];
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

describe('P1: provider kill switches stay authoritative over health probes', () => {
  it('keeps a killed provider unroutable after a successful live probe and does not re-enter Nexus candidates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-kill-probe-'));
    const transport = new ScriptedTransport((request) => {
      if (request.url.includes('/api/tags')) {
        return responseFromText(200, JSON.stringify({ models: [{ name: 'llama3.2' }] }));
      }
      return responseFromText(200, JSON.stringify({ ok: true }));
    });
    const spine = await composeSpine({
      dataPath: join(dir, 'state.json'),
      mode: 'live',
      env: {
        ATLAS_KILL_PROVIDERS: 'ollama,forge',
        OPENAI_API_KEY: 'sk-test',
      },
      transport,
    });
    spines.push(spine);

    expect(spine.health.ollama).toBe('healthy');
    const ollama = spine.registry.get('ollama', 'llama3.2');
    expect(ollama).toBeTruthy();
    expect(ollama?.health).toBe('healthy');
    expect(spine.registry.isDisabled('ollama')).toBe(true);
    expect(spine.registry.isRoutable(ollama!)).toBe(false);

    spine.registry.setHealth('ollama', 'healthy');
    spine.registry.setHealth('forge', 'healthy');
    expect(spine.registry.isRoutable(spine.registry.get('ollama', 'llama3.2')!)).toBe(false);

    expect(() => spine.router.resolve('nexus/local')).toThrow(/No healthy candidates/);
    expect(() => spine.router.resolve('ollama/llama3.2')).toThrow();
    const fast = spine.router.resolve('nexus/fast');
    expect(fast.candidateChain.some((id) => id.startsWith('ollama/'))).toBe(false);
    expect(fast.candidateChain.some((id) => id.startsWith('forge/'))).toBe(false);
    expect(fast.provider).not.toBe('ollama');

    spine.registry.setHealth('openai', 'healthy');
    expect(spine.registry.isRoutable(spine.registry.get('openai', 'gpt-4o')!)).toBe(true);
    expect(spine.router.resolve('nexus/fast').provider).toBe('openai');
  });
});

describe('P1: stream permit is released when run admission fails', () => {
  it('does not leak stream capacity when run slots are exhausted', async () => {
    const started = await startProductionHost({
      env: {
        ATLAS_MAX_CONCURRENT_RUNS: '1',
        ATLAS_MAX_CONCURRENT_STREAMS: '8',
      },
    });
    servers.push(started.server);
    spines.push(started.spine);

    const originalSend = started.spine.runtime.sendMessage.bind(started.spine.runtime);
    started.spine.runtime.sendMessage = ((...args: Parameters<ConversationRuntime['sendMessage']>) => {
      const inner = originalSend(...args);
      return (async function* () {
        const first = await inner.next();
        if (!first.done) yield first.value;
        await new Promise<void>((resolve) => hangReleases.push(resolve));
        await inner.return?.(undefined);
      })();
    }) as ConversationRuntime['sendMessage'];

    const session = await bootstrap(started.url);
    const created = await fetch(`${started.url}/api/conversations`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({}),
    });
    const conversation = (await created.json()) as { id: string };
    const tenantId = started.spine.tenantId;

    const hanging = fetch(`${started.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ content: 'hold the run slot', capability: 'nexus/fast' }),
    });

    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline && started.spine.resources.occupancy(tenantId).runs < 1) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(started.spine.resources.occupancy(tenantId)).toEqual({ streams: 1, runs: 1 });

    for (let i = 0; i < 6; i += 1) {
      const rejected = await fetch(`${started.url}/api/conversations/${conversation.id}/messages`, {
        method: 'POST',
        headers: authHeaders(session),
        body: JSON.stringify({ content: `overflow ${i}`, capability: 'nexus/fast' }),
      });
      expect(rejected.status).toBe(429);
      const body = (await rejected.json()) as { code: string; error: string };
      expect(body.code).toBe('rate_limit');
      expect(body.error).toMatch(/run limit/i);
      expect(started.spine.resources.occupancy(tenantId)).toEqual({ streams: 1, runs: 1 });
    }

    hangReleases.pop()?.();
    const frames = await readSse(await hanging);
    expect(frames.length).toBeGreaterThan(0);
    expect(started.spine.resources.occupancy(tenantId)).toEqual({ streams: 0, runs: 0 });
  });
});

describe('P1: SSE idle timeout cancels stalled execution and restores permits', () => {
  it('terminates a never-yielding iterator, cancels the runtime, and restores admission', async () => {
    const started = await startProductionHost({
      env: { ATLAS_STREAM_IDLE_TIMEOUT_MS: '40' },
    });
    servers.push(started.server);
    spines.push(started.spine);

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
    started.spine.runtime.sendMessage = (async function* () {
      yield { type: 'execution', execution: { id: 'ex_stall', status: 'running' } } as never;
      await new Promise<void>((resolve) => hangReleases.push(resolve));
    }) as ConversationRuntime['sendMessage'];

    const session = await bootstrap(started.url);
    const created = await fetch(`${started.url}/api/conversations`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({}),
    });
    const conversation = (await created.json()) as { id: string };
    const tenantId = started.spine.tenantId;

    const stream = await fetch(`${started.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ content: 'stall please', capability: 'nexus/fast' }),
    });
    expect(stream.status).toBe(200);
    const frames = await readSse(stream);
    expect(frames.some((frame) => frame.event === 'error')).toBe(true);
    const error = frames.find((frame) => frame.event === 'error')?.data as { failure?: { code?: string } };
    expect(error.failure?.code).toBe('timeout');
    expect(cancelled).toEqual(['ex_stall']);
    expect(frames.some((frame) => frame.event === 'done')).toBe(false);
    expect(started.spine.resources.occupancy(tenantId)).toEqual({ streams: 0, runs: 0 });
  });
});

describe('P1: SSE timeout/cancellation races release admission exactly once', () => {
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

  it('releases permits once on normal completion without cancelling', async () => {
    const started = await startProductionHost({ streamDelayMs: 5 });
    servers.push(started.server);
    spines.push(started.spine);
    const cancelled: string[] = [];
    const originalCancel = started.spine.runtime.cancel.bind(started.spine.runtime);
    started.spine.runtime.cancel = (async (executionId: string) => {
      cancelled.push(executionId);
      return originalCancel(executionId);
    }) as ConversationRuntime['cancel'];

    const session = await bootstrap(started.url);
    const created = await fetch(`${started.url}/api/conversations`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({}),
    });
    const conversation = (await created.json()) as { id: string };
    const tenantId = started.spine.tenantId;
    const stream = await fetch(`${started.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ content: 'complete normally', capability: 'nexus/fast' }),
    });
    const frames = await readSse(stream);
    expect(frames.some((frame) => frame.event === 'done')).toBe(true);
    expect(frames.some((frame) => frame.event === 'error')).toBe(false);
    expect(cancelled).toEqual([]);
    expect(started.spine.resources.occupancy(tenantId)).toEqual({ streams: 0, runs: 0 });
  });

  it('cancels once and restores occupancy when the client disconnects', async () => {
    const started = await startProductionHost();
    servers.push(started.server);
    spines.push(started.spine);
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
        yield { type: 'execution', execution: { id: 'ex_disconnect', status: 'running' } } as never;
        await new Promise<void>((resolve) => hangReleases.push(resolve));
      })();
    }) as ConversationRuntime['sendMessage'];

    const session = await bootstrap(started.url);
    const created = await fetch(`${started.url}/api/conversations`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({}),
    });
    const conversation = (await created.json()) as { id: string };
    const tenantId = started.spine.tenantId;
    const abort = new AbortController();
    const stream = await fetch(`${started.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ content: 'hold until disconnect', capability: 'nexus/fast' }),
      signal: abort.signal,
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await waitForOccupancy(() => started.spine.resources.occupancy(tenantId), { streams: 1, runs: 1 });
    abort.abort();
    await reader.cancel().catch(() => undefined);
    await waitForOccupancy(() => started.spine.resources.occupancy(tenantId), { streams: 0, runs: 0 });
    hangReleases.pop()?.();
    expect(cancelled).toEqual(['ex_disconnect']);
  });

  it('treats explicit cancel as a single runtime cancel and restores occupancy', async () => {
    const started = await startProductionHost({ streamDelayMs: 80 });
    servers.push(started.server);
    spines.push(started.spine);
    const cancelled: string[] = [];
    const originalCancel = started.spine.runtime.cancel.bind(started.spine.runtime);
    started.spine.runtime.cancel = (async (executionId: string) => {
      cancelled.push(executionId);
      return originalCancel(executionId);
    }) as ConversationRuntime['cancel'];

    const session = await bootstrap(started.url);
    const created = await fetch(`${started.url}/api/conversations`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({}),
    });
    const conversation = (await created.json()) as { id: string };
    const tenantId = started.spine.tenantId;
    const stream = await fetch(`${started.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ content: 'cancel from another request please', capability: 'nexus/fast' }),
    });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let executionId: string | null = null;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && !executionId) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const block of parts) {
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = JSON.parse(line.slice(6)) as { execution?: { id?: string }; executionId?: string };
          executionId = data.execution?.id ?? data.executionId ?? executionId;
        }
      }
    }
    expect(executionId).toBeTruthy();
    const cancel = await fetch(`${started.url}/api/executions/${executionId}/cancel`, {
      method: 'POST',
      headers: authHeaders(session),
      body: '{}',
    });
    expect(cancel.status).toBe(200);
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    await waitForOccupancy(() => started.spine.resources.occupancy(tenantId), { streams: 0, runs: 0 });
    expect(cancelled).toEqual([executionId]);
  });
});

describe('P2: ATLAS_HTTP_TIMEOUT_MS is applied without capping SSE', () => {
  it('wires inbound HTTP timeouts and closes a stalled request body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-http-timeout-'));
    const spine = await composeSpine({ dataPath: join(dir, 'state.json'), mode: 'mock' });
    spines.push(spine);
    const timeouts = readTimeoutContract({ ATLAS_HTTP_TIMEOUT_MS: '250' });
    const server = createHost({ runtime: spine.runtime, timeouts });
    servers.push(server);
    const bound = await listen(server, 0, '127.0.0.1');

    expect(server.requestTimeout).toBe(250);
    expect(server.headersTimeout).toBe(250);
    expect(server.timeout).toBe(250);

    const received = await new Promise<{ data: string; elapsed: number }>((resolve, reject) => {
      const startedAt = Date.now();
      const socket = net.connect(bound.port, '127.0.0.1');
      let data = '';
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('inbound request did not time out'));
      }, 2_000);
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
      });
      socket.on('error', () => undefined);
      socket.on('close', () => {
        clearTimeout(timer);
        resolve({ data, elapsed: Date.now() - startedAt });
      });
      socket.on('connect', () => {
        socket.write(
          'POST /api/conversations HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n{',
        );
      });
    });
    expect(received.elapsed).toBeLessThan(1_500);
    expect(received.elapsed).toBeGreaterThanOrEqual(200);
  });

  it('does not cut off a legitimate SSE stream that outlasts the inbound HTTP timeout', async () => {
    const started = await startProductionHost({
      streamDelayMs: 70,
      env: {
        ATLAS_HTTP_TIMEOUT_MS: '40',
        ATLAS_STREAM_IDLE_TIMEOUT_MS: '5000',
      },
    });
    servers.push(started.server);
    spines.push(started.spine);
    expect(started.server.requestTimeout).toBe(40);
    expect(started.server.timeout).toBe(40);

    const session = await bootstrap(started.url);
    const created = await fetch(`${started.url}/api/conversations`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({}),
    });
    const conversation = (await created.json()) as { id: string };
    const startedAt = Date.now();
    const stream = await fetch(`${started.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ content: 'please stream several chunks of text for the timeout regression', capability: 'nexus/fast' }),
    });
    const frames = await readSse(stream);
    expect(Date.now() - startedAt).toBeGreaterThan(40);
    expect(frames.some((frame) => frame.event === 'done')).toBe(true);
    expect(frames.some((frame) => frame.event === 'error')).toBe(false);
  });
});
