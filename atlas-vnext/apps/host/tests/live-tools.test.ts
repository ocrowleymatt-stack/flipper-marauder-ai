import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PersistenceConfig } from '@atlas-vnext/persistence';
import { MapSecretStore, responseFromText, type HttpRequest } from '@atlas-vnext/execution';
import { composeSpine, type Spine } from '../src/index.ts';

const spines: Spine[] = [];

afterEach(async () => {
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

function openaiToolCallSse(id: string, query: string): string {
  return sse([
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                function: { name: 'retrieval.search', arguments: JSON.stringify({ query }) },
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
    })) {
      events.push(event);
    }

    const chatBodies = bodies.filter((body) => Array.isArray(body.messages));
    expect(chatBodies).toHaveLength(3);
    const advertised = JSON.stringify(chatBodies[0]?.tools);
    expect(advertised).toContain('retrieval.search');
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
});
