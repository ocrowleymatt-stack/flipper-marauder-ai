import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { composeSpine, createHost, listen } from '../src/index.ts';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
});

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-host-'));
  const spine = await composeSpine({ dataPath: join(dir, 'state.json'), mode: 'mock' });
  const server = createHost({ runtime: spine.runtime });
  servers.push(server);
  const bound = await listen(server, 0, '127.0.0.1');
  return { ...bound, spine };
}

async function readSse(response: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await response.text();
  const frames: Array<{ event: string; data: unknown }> = [];
  let currentEvent = 'message';
  for (const line of text.split('\n')) {
    if (line.startsWith('event: ')) currentEvent = line.slice(7).trim();
    else if (line.startsWith('data: ')) {
      frames.push({ event: currentEvent, data: JSON.parse(line.slice(6)) });
      currentEvent = 'message';
    }
  }
  return frames;
}

describe('conversation spine HTTP/SSE', () => {
  it('creates a conversation, streams a routed reply, and survives reload', async () => {
    const { url, spine } = await start();
    const created = await fetch(`${url}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(201);
    const conversation = (await created.json()) as { id: string };

    const stream = await fetch(`${url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hello atlas', capability: 'nexus/fast' }),
    });
    expect(stream.headers.get('content-type')).toMatch(/text\/event-stream/);
    const frames = await readSse(stream);
    expect(frames.some((frame) => frame.event === 'done')).toBe(true);
    const executionFrame = [...frames].reverse().find((frame) => frame.event === 'execution');
    const execution = executionFrame?.data as {
      type: string;
      execution: {
        status: string;
        selectedProvider: string;
        selectedModel: string;
        capability: string;
        usage: { totalTokens: number } | null;
      };
    };
    expect(execution.execution.status).toBe('completed');
    expect(execution.execution.capability).toBe('nexus/fast');
    expect(execution.execution.selectedProvider).toBe('openai');
    expect(execution.execution.selectedModel).toBe('gpt-4o');
    expect(execution.execution.usage?.totalTokens).toBeGreaterThan(0);

    const listed = await fetch(`${url}/api/conversations`);
    const conversations = (await listed.json()) as Array<{ id: string; title: string }>;
    expect(conversations[0]?.id).toBe(conversation.id);
    expect(conversations[0]?.title).toBe('hello atlas');

    const snapshot = await spine.runtime.getSnapshot(conversation.id);
    expect(snapshot?.messages).toHaveLength(2);
    expect(snapshot?.messages[1]?.content).toContain('openai/gpt-4o');
    expect(snapshot?.executions[0]?.route?.target).toBe('nexus/fast');
  });

  it('routes nexus/reason to the reasoning model', async () => {
    const { url } = await start();
    const created = await fetch(`${url}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Reason' }),
    });
    const conversation = (await created.json()) as { id: string };
    const stream = await fetch(`${url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'why', capability: 'nexus/reason' }),
    });
    const frames = await readSse(stream);
    const execution = [...frames].reverse().find((frame) => frame.event === 'execution')?.data as {
      execution: { selectedProvider: string; selectedModel: string; capability: string };
    };
    expect(execution.execution.capability).toBe('nexus/reason');
    expect(execution.execution.selectedProvider).toBe('anthropic');
    expect(execution.execution.selectedModel).toBe('claude-sonnet');
  });

  it('failes over before visible output and refuses to switch after partial text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-host-'));
    const spine = await composeSpine({ dataPath: join(dir, 'state.json'), mode: 'mock' });
    spine.broker.register({
      providerId: 'openai',
      async *stream() {
        throw new Error('timeout before tokens');
      },
    });
    const server = createHost({ runtime: spine.runtime });
    servers.push(server);
    const { url } = await listen(server, 0, '127.0.0.1');
    const created = await fetch(`${url}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const conversation = (await created.json()) as { id: string };
    const stream = await fetch(`${url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'recover', capability: 'nexus/fast' }),
    });
    const frames = await readSse(stream);
    const execution = [...frames].reverse().find((frame) => frame.event === 'execution')?.data as {
      execution: { status: string; selectedProvider: string; attempts: Array<{ provider: string; outcome: string }> };
    };
    expect(execution.execution.status).toBe('completed');
    expect(execution.execution.selectedProvider).toBe('gemini');
    expect(execution.execution.attempts.some((attempt) => attempt.provider === 'openai' && attempt.outcome === 'failed')).toBe(
      true,
    );

    const partialSpine = await composeSpine({ dataPath: join(dir, 'partial.json'), mode: 'mock' });
    partialSpine.broker.register({
      providerId: 'openai',
      async *stream() {
        yield { type: 'text' as const, text: 'visible' };
        throw new Error('cut');
      },
    });
    const partialServer = createHost({ runtime: partialSpine.runtime });
    servers.push(partialServer);
    const partialBound = await listen(partialServer, 0, '127.0.0.1');
    const createdPartial = await fetch(`${partialBound.url}/api/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const partialConversation = (await createdPartial.json()) as { id: string };
    const partialStream = await fetch(`${partialBound.url}/api/conversations/${partialConversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'stay', capability: 'nexus/fast' }),
    });
    const partialFrames = await readSse(partialStream);
    expect(partialFrames.some((frame) => frame.event === 'error')).toBe(true);
    const failed = [...partialFrames].reverse().find((frame) => frame.event === 'execution')?.data as {
      execution: { status: string; selectedProvider: string; failureReason: { code: string } | null };
    };
    expect(failed.execution.status).toBe('failed');
    expect(failed.execution.failureReason?.code).toBe('partial_stream_failure');
    const snapshot = await partialSpine.runtime.getSnapshot(partialConversation.id);
    expect(snapshot?.messages.at(-1)?.content).toBe('visible');
  });

  it('starts in live mode without credentials instead of crashing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-host-'));
    const spine = await composeSpine({
      dataPath: join(dir, 'live.json'),
      mode: 'live',
      env: {},
      transport: {
        async send() {
          throw new Error('connect ECONNREFUSED');
        },
      },
    });
    expect(spine.mode).toBe('live');
    expect(spine.health.openai).toBe('unavailable');
    expect(spine.health.ollama).toBe('unhealthy');
    const server = createHost({ runtime: spine.runtime, health: { mode: spine.mode, providers: spine.health } });
    servers.push(server);
    const bound = await listen(server, 0, '127.0.0.1');
    const created = await fetch(`${bound.url}/api/health`);
    const health = (await created.json()) as { ok: boolean; providers: Record<string, string> };
    expect(health.ok).toBe(true);
    expect(health.providers.openai).toBe('unavailable');
  });
});
