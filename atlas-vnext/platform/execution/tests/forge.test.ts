import { describe, expect, it } from 'vitest';
import type { StreamChunk } from '@atlas-vnext/contracts';
import {
  MapSecretStore,
  createExecutionPlane,
  createForgeAdapter,
  probeForgeHealth,
  responseFromText,
  type HttpRequest,
  type HttpTransport,
} from '@atlas-vnext/execution';

const KEY = 'forge-test-secret-value-do-not-leak';

function sse(payloads: string[]): string {
  return payloads.map((data) => `data: ${data}\n\n`).join('');
}

function transportFor(handler: (request: HttpRequest) => { status: number; body: string }): HttpTransport {
  return {
    async send(request) {
      const result = handler(request);
      return responseFromText(result.status, result.body, { 'content-type': 'text/event-stream' });
    },
  };
}

async function collect(stream: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('Forge / Hetzner private inference', () => {
  it('treats Forge as the inference service on Hetzner (one provider)', async () => {
    const adapter = createForgeAdapter({
      secrets: new MapSecretStore({ FORGE_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://forge.example.internal',
      protocol: 'openai',
      chatPath: '/v1/chat/completions',
      healthPath: '/v1/models',
      transport: transportFor((request) => {
        expect(request.url).toBe('https://forge.example.internal/v1/chat/completions');
        expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
        return { status: 200, body: sse(['{"choices":[{"delta":{"content":"private"}}]}', '[DONE]']) };
      }),
    });
    expect(adapter.providerId).toBe('forge');
    const chunks = await collect(adapter.stream('llama3.2', { prompt: 'hi' }));
    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([{ type: 'text', text: 'private' }]);
  });

  it('allows unauthenticated private-LAN Forge and probes health', async () => {
    const transport = transportFor((request) => {
      if (request.method === 'GET') {
        expect(request.url).toContain('/v1/models');
        return { status: 200, body: JSON.stringify({ data: [{ id: 'llama3.2' }, { id: 'qwen3:4b-instruct' }] }) };
      }
      return { status: 200, body: sse(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]']) };
    });
    const probed = await probeForgeHealth({
      transport,
      timeoutMs: 5_000,
      baseUrl: 'https://forge.example.internal',
      healthPath: '/v1/models',
      protocol: 'openai',
      secrets: new MapSecretStore({}),
    });
    expect(probed.health).toBe('healthy');
    expect(probed.models).toEqual(['llama3.2', 'qwen3:4b-instruct']);
  });

  it('uses Ollama protocol when the private host speaks /api/chat', async () => {
    const adapter = createForgeAdapter({
      secrets: new MapSecretStore({}),
      timeoutMs: 5_000,
      baseUrl: 'http://10.0.0.8:11434',
      protocol: 'ollama',
      chatPath: '/api/chat',
      healthPath: '/api/tags',
      transport: transportFor(() => ({
        status: 200,
        body: `${JSON.stringify({ message: { content: 'hosted' }, done: true, prompt_eval_count: 1, eval_count: 1 })}\n`,
      })),
    });
    expect(adapter.providerId).toBe('forge');
    const chunks = await collect(adapter.stream('qwen3', { prompt: 'hi' }));
    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([{ type: 'text', text: 'hosted' }]);
  });

  it('is unavailable without an endpoint and does not invent a hetzner provider', () => {
    const plane = createExecutionPlane({
      mode: 'live',
      env: {},
      secrets: new MapSecretStore({}),
    });
    expect(plane.health.forge).toBe('unavailable');
    expect(plane.health.hetzner).toBeUndefined();
    expect(plane.broker.registeredProviders()).not.toContain('hetzner');
  });

  it('registers forge when ATLAS_FORGE_BASE_URL is set', () => {
    const plane = createExecutionPlane({
      mode: 'live',
      env: { ATLAS_FORGE_BASE_URL: 'https://forge.example.internal' },
      secrets: new MapSecretStore({}),
    });
    expect(plane.available).toContain('forge');
    expect(plane.health.forge).toBe('configured');
  });

  it('redacts Forge credentials that are not sk- prefixed', async () => {
    const arbitrary = 'nona-prefixed-forge-token-value-xyz';
    const probed = await probeForgeHealth({
      transport: transportFor(() => ({ status: 401, body: `unauthorized ${arbitrary}` })),
      timeoutMs: 5_000,
      baseUrl: 'https://forge.example.internal',
      healthPath: '/v1/models',
      protocol: 'openai',
      secrets: new MapSecretStore({ FORGE_API_KEY: arbitrary }),
    });
    expect(probed.health).toBe('authentication_failure');
    expect(probed.detail).not.toContain(arbitrary);
  });
});
