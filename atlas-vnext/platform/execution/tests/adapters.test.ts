import { describe, expect, it } from 'vitest';
import type { StreamChunk } from '@atlas-vnext/contracts';
import {
  AnthropicAdapter,
  GeminiAdapter,
  HETZNER_IS_FORGE_HOST,
  MapSecretStore,
  OllamaAdapter,
  createExecutionPlane,
  createOpenAIAdapter,
  createVeniceAdapter,
  responseFromText,
  type HttpRequest,
  type HttpTransport,
} from '@atlas-vnext/execution';

const KEY = 'sk-test-secret-value-do-not-leak';

function sse(payloads: string[]): string {
  return payloads.map((data) => `data: ${data}\n\n`).join('');
}

function transportFor(handler: (request: HttpRequest) => { status: number; body: string; headers?: Record<string, string> }): HttpTransport {
  return {
    async send(request) {
      const result = handler(request);
      return responseFromText(result.status, result.body, result.headers ?? { 'content-type': 'text/event-stream' });
    },
  };
}

async function collect(stream: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('OpenAI adapter contract', () => {
  it('normalises SSE text, usage, and does not invent tokens when usage is absent', async () => {
    const withUsage = createOpenAIAdapter({
      secrets: new MapSecretStore({ OPENAI_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://api.openai.com/v1',
      transport: transportFor(() => ({
        status: 200,
        body: sse([
          '{"choices":[{"delta":{"content":"Hel"}}]}',
          '{"choices":[{"delta":{"content":"lo"}}]}',
          '{"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
          '[DONE]',
        ]),
      })),
    });
    const chunks = await collect(withUsage.stream('gpt-4o', { prompt: 'hi' }));
    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ]);
    expect(chunks.filter((chunk) => chunk.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
    ]);

    const noUsage = createOpenAIAdapter({
      secrets: new MapSecretStore({ OPENAI_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://api.openai.com/v1',
      transport: transportFor(() => ({
        status: 200,
        body: sse(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]']),
      })),
    });
    const plain = await collect(noUsage.stream('gpt-4o', { prompt: 'hi' }));
    expect(plain.some((chunk) => chunk.type === 'usage')).toBe(false);
  });

  it('sanitises HTTP errors and never echoes the API key', async () => {
    const adapter = createOpenAIAdapter({
      secrets: new MapSecretStore({ OPENAI_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://api.openai.com/v1',
      transport: transportFor((request) => {
        expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
        return { status: 401, body: `invalid api key ${KEY}` };
      }),
    });
    await expect(collect(adapter.stream('gpt-4o', { prompt: 'hi' }))).rejects.toThrow(/authentication_failure|HTTP 401/);
    try {
      await collect(adapter.stream('gpt-4o', { prompt: 'hi' }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(KEY);
    }
  });

  it('is unavailable without credentials rather than crashing the process', async () => {
    const adapter = createOpenAIAdapter({
      secrets: new MapSecretStore({}),
      timeoutMs: 5_000,
      baseUrl: 'https://api.openai.com/v1',
      transport: transportFor(() => ({ status: 200, body: '' })),
    });
    await expect(collect(adapter.stream('gpt-4o', { prompt: 'hi' }))).rejects.toThrow(/missing credentials/);
  });

  it('assembles fragmented tool-call arguments across SSE deltas before emitting', async () => {
    const adapter = createOpenAIAdapter({
      secrets: new MapSecretStore({ OPENAI_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://api.openai.com/v1',
      transport: transportFor(() => ({
        status: 200,
        body: sse([
          '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_lookup","function":{"name":"lookup","arguments":"{\\"q\\":\\""}}]}}]}',
          '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"atlas"}}]}}]}',
          '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"}"}}]}}]}',
          '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
          '[DONE]',
        ]),
      })),
    });
    const chunks = await collect(adapter.stream('gpt-4o', { prompt: 'search' }));
    expect(chunks.filter((chunk) => chunk.type === 'tool_call')).toEqual([
      { type: 'tool_call', call: { id: 'call_lookup', toolId: 'lookup', arguments: { q: 'atlas' } } },
    ]);
    expect(chunks.some((chunk) => chunk.type === 'warning')).toBe(false);
  });

  it('does not emit a tool_call from a JSON-invalid argument fragment', async () => {
    const adapter = createOpenAIAdapter({
      secrets: new MapSecretStore({ OPENAI_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://api.openai.com/v1',
      transport: transportFor(() => ({
        status: 200,
        body: sse([
          '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bad","function":{"name":"lookup","arguments":"{\\"q\\":"}}]}}]}',
          '[DONE]',
        ]),
      })),
    });
    const chunks = await collect(adapter.stream('gpt-4o', { prompt: 'search' }));
    expect(chunks.some((chunk) => chunk.type === 'tool_call')).toBe(false);
    expect(chunks.some((chunk) => chunk.type === 'warning')).toBe(true);
  });
});

describe('Anthropic adapter contract', () => {
  it('normalises content_block_delta text and reported usage', async () => {
    const adapter = new AnthropicAdapter({
      secrets: new MapSecretStore({ ANTHROPIC_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://api.anthropic.com',
      transport: transportFor(() => ({
        status: 200,
        body: [
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":1}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n',
        ].join(''),
      })),
    });
    const chunks = await collect(adapter.stream('claude-sonnet', { prompt: 'hi' }));
    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([{ type: 'text', text: 'Hi' }]);
    expect(chunks.filter((chunk) => chunk.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 9, outputTokens: 2, totalTokens: 11 } },
    ]);
  });

  it('buffers input_json_delta fragments and does not emit a tool_call from incomplete JSON', async () => {
    const adapter = new AnthropicAdapter({
      secrets: new MapSecretStore({ ANTHROPIC_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://api.anthropic.com',
      transport: transportFor(() => ({
        status: 200,
        body: [
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\""}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"atlas\\"}"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        ].join(''),
      })),
    });
    const chunks = await collect(adapter.stream('claude-sonnet', { prompt: 'search' }));
    expect(chunks.filter((chunk) => chunk.type === 'tool_call')).toEqual([
      { type: 'tool_call', call: { id: 'toolu_1', toolId: 'lookup', arguments: { q: 'atlas' } } },
    ]);

    const incomplete = new AnthropicAdapter({
      secrets: new MapSecretStore({ ANTHROPIC_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://api.anthropic.com',
      transport: transportFor(() => ({
        status: 200,
        body: [
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_bad","name":"lookup"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        ].join(''),
      })),
    });
    const dropped = await collect(incomplete.stream('claude-sonnet', { prompt: 'search' }));
    expect(dropped.some((chunk) => chunk.type === 'tool_call')).toBe(false);
    expect(dropped.some((chunk) => chunk.type === 'warning')).toBe(true);
  });
});

describe('Gemini adapter contract', () => {
  it('normalises candidate parts and usageMetadata', async () => {
    const adapter = new GeminiAdapter({
      secrets: new MapSecretStore({ GEMINI_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      transport: transportFor((request) => {
        expect(request.headers['x-goog-api-key']).toBe(KEY);
        expect(request.url).toContain('gemini-2.0-flash');
        return {
          status: 200,
          body: sse([
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'flash' }] } }],
              usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
            }),
          ]),
        };
      }),
      modelMap: { flash: 'gemini-2.0-flash' },
    });
    const chunks = await collect(adapter.stream('flash', { prompt: 'hi' }));
    expect(chunks).toEqual([
      { type: 'text', text: 'flash' },
      { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } },
    ]);
  });

  it('assembles functionCall parts across SSE events before emitting a tool_call', async () => {
    const adapter = new GeminiAdapter({
      secrets: new MapSecretStore({ GEMINI_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      transport: transportFor(() => ({
        status: 200,
        body: sse([
          JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'lookup' } }] } }] }),
          JSON.stringify({
            candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: '{"q":"' } }] } }],
          }),
          JSON.stringify({
            candidates: [{ content: { parts: [{ functionCall: { args: 'atlas"}' } }] } }],
          }),
        ]),
      })),
    });
    const chunks = await collect(adapter.stream('flash', { prompt: 'search' }));
    expect(chunks.filter((chunk) => chunk.type === 'tool_call')).toEqual([
      { type: 'tool_call', call: { id: 'lookup', toolId: 'lookup', arguments: { q: 'atlas' } } },
    ]);

    const incomplete = new GeminiAdapter({
      secrets: new MapSecretStore({ GEMINI_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      transport: transportFor(() => ({
        status: 200,
        body: sse([
          JSON.stringify({
            candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: '{"q":' } }] } }],
          }),
        ]),
      })),
    });
    const dropped = await collect(incomplete.stream('flash', { prompt: 'search' }));
    expect(dropped.some((chunk) => chunk.type === 'tool_call')).toBe(false);
    expect(dropped.some((chunk) => chunk.type === 'warning')).toBe(true);
  });
});

describe('Venice adapter contract', () => {
  it('uses the OpenAI-compatible protocol under providerId venice', async () => {
    const adapter = createVeniceAdapter({
      secrets: new MapSecretStore({ VENICE_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://api.venice.ai/api/v1',
      transport: transportFor((request) => {
        expect(request.url).toContain('venice.ai');
        expect(JSON.parse(request.body ?? '{}').venice_parameters).toBeTruthy();
        return {
          status: 200,
          body: sse(['{"choices":[{"delta":{"content":"local-ish"}}]}', '[DONE]']),
        };
      }),
    });
    expect(adapter.providerId).toBe('venice');
    const chunks = await collect(adapter.stream('uncensored', { prompt: 'hi' }));
    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([{ type: 'text', text: 'local-ish' }]);
  });

  it('assembles fragmented Venice tool-call arguments rather than parsing each delta', async () => {
    const adapter = createVeniceAdapter({
      secrets: new MapSecretStore({ VENICE_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://api.venice.ai/api/v1',
      transport: transportFor(() => ({
        status: 200,
        body: sse([
          '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_v","function":{"name":"search","arguments":"{\\"q\\":"}}]}}]}',
          '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"venice\\"}"}}]}}]}',
          '[DONE]',
        ]),
      })),
    });
    const chunks = await collect(adapter.stream('uncensored', { prompt: 'hi' }));
    expect(chunks.filter((chunk) => chunk.type === 'tool_call')).toEqual([
      { type: 'tool_call', call: { id: 'call_v', toolId: 'search', arguments: { q: 'venice' } } },
    ]);
  });
});

describe('Ollama local adapter', () => {
  it('streams NDJSON, discovers tags, and degrades on connection failure', async () => {
    const adapter = new OllamaAdapter({
      timeoutMs: 5_000,
      baseUrl: 'http://127.0.0.1:11434',
      transport: transportFor((request) => {
        if (request.url.endsWith('/api/tags')) {
          return { status: 200, body: JSON.stringify({ models: [{ name: 'llama3.2' }] }) };
        }
        return {
          status: 200,
          body: [
            JSON.stringify({ message: { content: 'yo' }, done: false }),
            JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 3, eval_count: 1 }),
            '',
          ].join('\n'),
        };
      }),
    });
    expect(await adapter.discover()).toEqual(['llama3.2']);
    const chunks = await collect(adapter.stream('llama3.2', { prompt: 'hi' }));
    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([{ type: 'text', text: 'yo' }]);
    expect(chunks.filter((chunk) => chunk.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } },
    ]);

    const down = new OllamaAdapter({
      timeoutMs: 5_000,
      baseUrl: 'http://127.0.0.1:11434',
      transport: {
        async send() {
          throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
        },
      },
    });
    await expect(down.discover()).rejects.toThrow(/connection failed/i);
  });
});

describe('placeholder providers', () => {
  it('does not register Hetzner as a fake second inference provider', () => {
    expect(HETZNER_IS_FORGE_HOST).toBe(true);
    const plane = createExecutionPlane({ mode: 'live', env: {}, secrets: new MapSecretStore({}) });
    expect(plane.broker.registeredProviders()).not.toContain('hetzner');
    expect(plane.health.hetzner).toBeUndefined();
  });
});

describe('execution plane availability', () => {
  it('starts with a subset of providers when credentials are missing', async () => {
    const plane = createExecutionPlane({
      mode: 'live',
      env: { OPENAI_API_KEY: KEY },
      secrets: new MapSecretStore({ OPENAI_API_KEY: KEY }),
      transport: transportFor((request) => {
        if (request.url.includes('/api/tags')) return { status: 500, body: 'down' };
        return { status: 200, body: sse(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]']) };
      }),
    });
    expect(plane.available).toContain('openai');
    expect(plane.available).toContain('ollama');
    expect(plane.unavailable).toEqual(expect.arrayContaining(['anthropic', 'gemini', 'venice', 'xai', 'runpod', 'forge']));
    expect(plane.health.anthropic).toBe('unavailable');
    expect(plane.health.runpod).toBe('unavailable');
    expect(plane.health.xai).toBe('unavailable');
    await plane.refreshOllamaHealth();
    expect(plane.health.ollama).toBe('unhealthy');
  });

  it('mock mode does not become the only implementation path', () => {
    const live = createExecutionPlane({ mode: 'live', env: {}, secrets: new MapSecretStore({}) });
    const mock = createExecutionPlane({ mode: 'mock', env: {} });
    expect(live.mode).toBe('live');
    expect(mock.mode).toBe('mock');
    expect(live.broker.registeredProviders()).not.toEqual(mock.broker.registeredProviders());
  });

  it('treats GOOGLE_API_KEY as a Gemini credential', () => {
    const plane = createExecutionPlane({
      mode: 'live',
      env: { GOOGLE_API_KEY: KEY },
      secrets: new MapSecretStore({ GOOGLE_API_KEY: KEY }),
    });
    expect(plane.available).toContain('gemini');
    expect(plane.unavailable).not.toContain('gemini');
  });

  it('keeps unrelated providers available when RunPod is down', async () => {
    const plane = createExecutionPlane({
      mode: 'live',
      env: { OPENAI_API_KEY: KEY, ANTHROPIC_API_KEY: KEY },
      secrets: new MapSecretStore({ OPENAI_API_KEY: KEY, ANTHROPIC_API_KEY: KEY }),
      transport: transportFor(() => ({
        status: 200,
        body: sse(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]']),
      })),
    });
    expect(plane.available).toEqual(expect.arrayContaining(['openai', 'anthropic', 'ollama']));
    expect(plane.unavailable).toContain('runpod');
    expect(plane.scheduler).toBeNull();
    const chunks: StreamChunk[] = [];
    for await (const chunk of plane.broker.execute(
      {
        target: 'openai/gpt-4o',
        resolvedRouteId: 'openai/gpt-4o',
        provider: 'openai',
        model: 'gpt-4o',
        candidateChain: ['openai/gpt-4o'],
        localOnly: false,
        locality: 'public_cloud',
        runtimeClass: 'always_available',
        decisionReason: 'explicit',
        traceId: 'trc',
        evaluatedAt: new Date().toISOString(),
      },
      { prompt: 'hi' },
    )) {
      chunks.push(chunk);
    }
    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([{ type: 'text', text: 'ok' }]);
  });
});
