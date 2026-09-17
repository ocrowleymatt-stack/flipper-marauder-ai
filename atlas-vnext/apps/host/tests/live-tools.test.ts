import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { PersistenceConfig } from '@atlas-vnext/persistence';
import { MapSecretStore, responseFromText, type HttpRequest } from '@atlas-vnext/execution';
import { composeSpine, createHost, listen, type Spine } from '../src/index.ts';

const spines: Spine[] = [];
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
  await Promise.all(spines.splice(0).map((spine) => spine.close()));
});

function memoryConfig(tenantId: string): PersistenceConfig {
  return {
    mode: 'memory',
    production: false,
    databaseUrl: null,
    poolMax: 4,
    idleTimeoutMs: 10_000,
    connectionTimeoutMs: 5_000,
    statementTimeoutMs: 30_000,
    filePath: null,
    defaultTenantId: tenantId,
  };
}

function sse(payloads: string[]): string {
  return payloads.map((data) => `data: ${data}\n\n`).join('');
}

function openaiToolCallSse(id: string, query: string, name = 'retrieval__search'): string {
  return sse([
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                function: { name, arguments: JSON.stringify({ query }) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
    '[DONE]',
  ]);
}

function advertisedToolPayload(body: Record<string, unknown> | undefined): string {
  return JSON.stringify(body?.tools ?? null);
}

function expectSideEffectToolsAbsent(payload: string): void {
  expect(payload).not.toContain('retrieval.search');
  expect(payload).not.toContain('retrieval__search');
  expect(payload).not.toContain('job.run');
  expect(payload).not.toContain('job__run');
  expect(payload).not.toContain('project.file_op');
  expect(payload).not.toContain('project__file_op');
}

async function startLiveSpine(transport: (request: HttpRequest, bodies: Record<string, unknown>[]) => Promise<ReturnType<typeof responseFromText>>) {
  const bodies: Record<string, unknown>[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'atlas-live-tools-'));
  const spine = await composeSpine({
    dataPath: join(dir, 'state.json'),
    mode: 'live',
    secrets: new MapSecretStore({ OPENAI_API_KEY: 'sk-test-secret-value-do-not-leak' }),
    env: { OPENAI_API_KEY: 'sk-test-secret-value-do-not-leak' },
    persistence: memoryConfig('tenant_a'),
    casRoot: join(dir, 'cas'),
    transport: {
      async send(request: HttpRequest) {
        const parsed = (request.body ? JSON.parse(request.body) : {}) as Record<string, unknown>;
        bodies.push(parsed);
        if (!request.url.includes('/chat/completions')) {
          return responseFromText(200, '{}', { 'content-type': 'application/json' });
        }
        return transport(request, bodies);
      },
    },
  });
  spines.push(spine);
  return { spine, bodies, dir };
}

describe('live provider tool orchestration', () => {
  it('advertises authorised tools, runs two sequential live OpenAI tool rounds, then a final answer', async () => {
    const bodies: Record<string, unknown>[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'atlas-live-tools-'));
    const spine = await composeSpine({
      dataPath: join(dir, 'state.json'),
      mode: 'live',
      secrets: new MapSecretStore({ OPENAI_API_KEY: 'sk-test-secret-value-do-not-leak' }),
      env: { OPENAI_API_KEY: 'sk-test-secret-value-do-not-leak' },
      persistence: memoryConfig('tenant_a'),
      casRoot: join(dir, 'cas'),
      transport: {
        async send(request: HttpRequest) {
          const parsed = (request.body ? JSON.parse(request.body) : {}) as Record<string, unknown>;
          bodies.push(parsed);
          if (!request.url.includes('/chat/completions')) {
            return responseFromText(200, '{}', { 'content-type': 'application/json' });
          }
          const messages = (parsed.messages as Array<{ role: string }>) ?? [];
          const toolMessages = messages.filter((row) => row.role === 'tool');
          if (toolMessages.length === 0) {
            return responseFromText(200, openaiToolCallSse('call_1', 'one'), {
              'content-type': 'text/event-stream',
            });
          }
          if (toolMessages.length === 1) {
            return responseFromText(200, openaiToolCallSse('call_2', 'two'), {
              'content-type': 'text/event-stream',
            });
          }
          return responseFromText(
            200,
            sse(['{"choices":[{"delta":{"content":"used both searches"}}]}', '[DONE]']),
            { 'content-type': 'text/event-stream' },
          );
        },
      },
    });
    spines.push(spine);

    const conversation = await spine.runtime.createConversation({ title: 'tools' });
    expect(conversation.tenantId).toBe('tenant_a');
    const events = [];
    for await (const event of spine.runtime.sendMessage(conversation.id, {
      content: 'search twice',
      requireTools: true,
      allowTools: true,
    })) {
      events.push(event);
    }

    const chatBodies = bodies.filter((body) => Array.isArray(body.messages));
    expect(chatBodies).toHaveLength(3);
    const advertised = JSON.stringify(chatBodies[0]?.tools);
    expect(advertised).toContain('retrieval__search');
    expect(advertised).toContain('job__run');
    expect(advertised).toContain('project__file_op');
    expect(advertised).not.toContain('retrieval.search');
    expect(advertised).not.toContain('fs.write');
    expect(advertised).not.toContain('admin.configure');
    expect(advertised).not.toMatch(/"name":"runpod"/i);

    const secondMessages = JSON.stringify(chatBodies[1]?.messages);
    expect(secondMessages).toContain('call_1');
    expect(secondMessages).toContain('tool_calls');
    expect(secondMessages).toContain('"role":"tool"');
    expect(secondMessages).toContain('\\"query\\":\\"one\\"');

    const thirdMessages = JSON.stringify(chatBodies[2]?.messages);
    expect(thirdMessages).toContain('call_1');
    expect(thirdMessages).toContain('call_2');
    expect(thirdMessages).toContain('\\"query\\":\\"two\\"');

    expect(events.filter((event) => event.type === 'tool.lifecycle' && event.status === 'succeeded')).toHaveLength(2);
    expect(events.some((event) => event.type === 'assistant.completed' && event.text.includes('used both searches'))).toBe(
      true,
    );
    expect(events.some((event) => event.type === 'execution.completed')).toBe(true);
    const snapshot = await spine.runtime.getSnapshot(conversation.id);
    expect(snapshot?.executions[0]?.status).toBe('completed');
    expect(snapshot?.executions[0]?.selectedProvider).toBe('openai');
  });

  it('does not advertise or handle default-grant tools on tools-off conversation send', async () => {
    const { spine, bodies } = await startLiveSpine(async () =>
      responseFromText(200, openaiToolCallSse('call_job', 'sneak', 'job__run'), {
        'content-type': 'text/event-stream',
      }),
    );
    const conversation = await spine.runtime.createConversation({ title: 'tools-off' });
    const events = [];
    for await (const event of spine.runtime.sendMessage(conversation.id, {
      content: 'search the project and enqueue a job',
    })) {
      events.push(event);
    }
    const chatBodies = bodies.filter((body) => Array.isArray(body.messages));
    expect(chatBodies.length).toBeGreaterThan(0);
    expectSideEffectToolsAbsent(advertisedToolPayload(chatBodies[0]));
    expect(chatBodies[0]?.tools).toBeUndefined();
    expect(events.some((event) => event.type === 'tool.lifecycle')).toBe(false);
    expect(events.some((event) => event.type === 'tool.requested')).toBe(false);
    const actor = { tenantId: spine.tenantId, principalId: spine.principalId };
    expect(await spine.tools.listByConversation(actor, conversation.id)).toEqual([]);
  });

  it('does not advertise or handle default-grant tools on Caspa generate when tools are off', async () => {
    const { spine, bodies } = await startLiveSpine(async () =>
      responseFromText(
        200,
        openaiToolCallSse('call_file', 'injected', 'project__file_op'),
        { 'content-type': 'text/event-stream' },
      ),
    );
    const actor = { tenantId: spine.tenantId, principalId: spine.principalId };
    const project = await spine.projects!.create(actor, { name: 'Book', dungeon: 'writing' });
    const created = await spine.writing!.create(actor, { projectId: project.id, title: 'Chapter' });
    const events = [];
    for await (const event of spine.writing!.generate(actor, created.id, {
      operation: 'create',
      instruction: 'Write a short chapter about a copper kettle.',
      expectedRevision: created.revision,
      fileIds: [],
    })) {
      events.push(event);
    }
    const chatBodies = bodies.filter((body) => Array.isArray(body.messages));
    expect(chatBodies.length).toBeGreaterThan(0);
    expectSideEffectToolsAbsent(advertisedToolPayload(chatBodies[0]));
    expect(chatBodies[0]?.tools).toBeUndefined();
    expect(events.some((event) => event.type === 'execution' && event.event.type === 'tool.lifecycle')).toBe(false);
    const after = await spine.writing!.get(actor, created.id);
    expect(after.conversationId).toBeTruthy();
    expect(await spine.tools.listByConversation(actor, after.conversationId!)).toEqual([]);
  });

  it('Workbench conversation send advertises tools only when the request opts in', async () => {
    const { spine, bodies } = await startLiveSpine(async (_request, collected) => {
      const last = collected.at(-1);
      const messages = (last?.messages as Array<{ role: string }>) ?? [];
      const toolMessages = messages.filter((row) => row.role === 'tool');
      if (toolMessages.length === 0 && last?.tools) {
        return responseFromText(200, openaiToolCallSse('call_1', 'one'), { 'content-type': 'text/event-stream' });
      }
      if (toolMessages.length === 1) {
        return responseFromText(200, openaiToolCallSse('call_2', 'two'), { 'content-type': 'text/event-stream' });
      }
      return responseFromText(200, sse(['{"choices":[{"delta":{"content":"used both searches"}}]}', '[DONE]']), {
        'content-type': 'text/event-stream',
      });
    });
    const server = createHost({
      runtime: spine.runtime,
      auth: spine.auth,
      tools: spine.tools,
      projects: spine.projects,
      files: spine.files,
      context: spine.context,
      persistence: spine.persistence,
      writing: spine.writing,
      privacy: spine.privacy,
      tenantId: spine.tenantId,
      principalId: spine.principalId,
      flags: spine.flags,
      killSwitches: spine.killSwitches,
      resources: spine.resources,
      maxRequestBytes: spine.limits.maxRequestBytes,
      maxUploadBytes: spine.limits.maxUploadBytes,
      timeouts: spine.timeouts,
    });
    servers.push(server);
    const bound = await listen(server, 0, '127.0.0.1');
    const sessionRes = await fetch(`${bound.url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const sessionBody = (await sessionRes.json()) as { csrfToken: string };
    const headers = {
      cookie: sessionRes.headers.get('set-cookie') ?? '',
      'x-atlas-csrf': sessionBody.csrfToken,
      'content-type': 'application/json',
    };
    const conversation = await spine.runtime.createConversation({ title: 'workbench' });

    const offRes = await fetch(`${bound.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'no tools please', capability: 'nexus/fast' }),
    });
    expect(offRes.ok).toBe(true);
    await offRes.text();
    const offBodies = bodies.filter((body) => Array.isArray(body.messages));
    expectSideEffectToolsAbsent(advertisedToolPayload(offBodies[0]));
    expect(offBodies[0]?.tools).toBeUndefined();

    const onConversation = await spine.runtime.createConversation({ title: 'workbench-on' });
    const onRes = await fetch(`${bound.url}/api/conversations/${onConversation.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'search twice', capability: 'nexus/fast', tools: true }),
    });
    expect(onRes.ok).toBe(true);
    await onRes.text();
    const onBodies = bodies.filter((body) => Array.isArray(body.messages)).slice(offBodies.length);
    expect(onBodies.length).toBeGreaterThanOrEqual(2);
    const advertised = advertisedToolPayload(onBodies[0]);
    expect(advertised).toContain('retrieval__search');
    expect(advertised).toContain('job__run');
    expect(advertised).toContain('project__file_op');
    expect(JSON.stringify(onBodies[1]?.messages)).toContain('"role":"tool"');
  });

  it('does not advertise tools when stored EffectivePolicy disables them', async () => {
    const { spine, bodies } = await startLiveSpine(async () =>
      responseFromText(200, sse(['{"choices":[{"delta":{"content":"no tools"}}]}', '[DONE]']), {
        'content-type': 'text/event-stream',
      }),
    );
    const server = createHost({
      runtime: spine.runtime,
      auth: spine.auth,
      tools: spine.tools,
      projects: spine.projects,
      files: spine.files,
      context: spine.context,
      persistence: spine.persistence,
      writing: spine.writing,
      privacy: spine.privacy,
      tenantId: spine.tenantId,
      principalId: spine.principalId,
      flags: spine.flags,
      killSwitches: spine.killSwitches,
      resources: spine.resources,
      maxRequestBytes: spine.limits.maxRequestBytes,
      maxUploadBytes: spine.limits.maxUploadBytes,
      timeouts: spine.timeouts,
    });
    servers.push(server);
    const bound = await listen(server, 0, '127.0.0.1');
    const sessionRes = await fetch(`${bound.url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const sessionBody = (await sessionRes.json()) as { csrfToken: string };
    const headers = {
      cookie: sessionRes.headers.get('set-cookie') ?? '',
      'x-atlas-csrf': sessionBody.csrfToken,
      'content-type': 'application/json',
    };
    const policyRes = await fetch(`${bound.url}/api/privacy/policy`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ patch: { toolsEnabled: false }, confirm: 'CONFIRM' }),
    });
    expect(policyRes.status).toBe(200);
    const conversation = await spine.runtime.createConversation({ title: 'policy-off' });
    const onRes = await fetch(`${bound.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'search anyway', capability: 'nexus/fast', tools: true }),
    });
    expect(onRes.ok).toBe(true);
    await onRes.text();
    const chatBodies = bodies.filter((body) => Array.isArray(body.messages));
    expect(chatBodies.length).toBeGreaterThan(0);
    expectSideEffectToolsAbsent(advertisedToolPayload(chatBodies[0]));
    expect(chatBodies[0]?.tools).toBeUndefined();
  });
});
