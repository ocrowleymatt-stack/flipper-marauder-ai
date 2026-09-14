import { describe, expect, it } from 'vitest';
import type { StreamChunk } from '@atlas-vnext/contracts';
import {
  MapSecretStore,
  createExecutionPlane,
  createXaiAdapter,
  responseFromText,
  type HttpRequest,
  type HttpTransport,
} from '@atlas-vnext/execution';

const KEY = 'xai-test-secret-value-do-not-leak';

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

describe('xAI Grok adapter', () => {
  it('reuses OpenAI-compatible transport under providerId xai', async () => {
    const adapter = createXaiAdapter({
      secrets: new MapSecretStore({ XAI_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://api.x.ai/v1',
      transport: transportFor((request) => {
        expect(request.url).toBe('https://api.x.ai/v1/chat/completions');
        expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
        const body = JSON.parse(request.body ?? '{}') as { model: string };
        expect(body.model).toBe('grok-4.6');
        return {
          status: 200,
          body: sse([
            '{"choices":[{"delta":{"content":"ATLAS"}}]}',
            '{"choices":[{"delta":{"reasoning_content":"think"}}]}',
            '{"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
            '[DONE]',
          ]),
        };
      }),
      modelMap: { 'grok-4.6': 'grok-4.6' },
    });
    expect(adapter.providerId).toBe('xai');
    const chunks = await collect(adapter.stream('grok-4.6', { prompt: 'hi' }));
    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([{ type: 'text', text: 'ATLAS' }]);
    expect(chunks.filter((chunk) => chunk.type === 'reasoning')).toEqual([{ type: 'reasoning', text: 'think' }]);
    expect(chunks.filter((chunk) => chunk.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } },
    ]);
  });

  it('accepts GROK_API_KEY as an alias and never echoes it', async () => {
    const adapter = createXaiAdapter({
      secrets: new MapSecretStore({ GROK_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://api.x.ai/v1',
      transport: transportFor(() => ({ status: 401, body: `invalid api key ${KEY}` })),
    });
    await expect(collect(adapter.stream('grok-4.3', { prompt: 'hi' }))).rejects.toThrow(/authentication_failure|HTTP 401/);
    try {
      await collect(adapter.stream('grok-4.3', { prompt: 'hi' }));
    } catch (err) {
      expect(err instanceof Error ? err.message : String(err)).not.toContain(KEY);
    }
  });

  it('retries 429/5xx via the broker but does not retry authentication failures', async () => {
    let calls = 0;
    const plane = createExecutionPlane({
      mode: 'live',
      secrets: new MapSecretStore({ XAI_API_KEY: KEY }),
      env: { XAI_API_KEY: KEY, ATLAS_PROVIDER_ATTEMPTS: '2' },
      transport: transportFor(() => {
        calls += 1;
        return { status: 401, body: 'nope' };
      }),
    });
    await expect(async () => {
      for await (const _chunk of plane.broker.execute(
        {
          target: 'xai/grok-4.6',
          resolvedRouteId: 'xai/grok-4.6',
          provider: 'xai',
          model: 'grok-4.6',
          candidateChain: ['xai/grok-4.6'],
          localOnly: false,
          locality: 'public_cloud',
          runtimeClass: 'always_available',
          decisionReason: 'explicit',
          traceId: 'trc',
          evaluatedAt: new Date().toISOString(),
        },
        { prompt: 'hi' },
      )) {
        // drain
      }
    }).rejects.toThrow(/authentication_failure|HTTP 401/);
    expect(calls).toBe(1);
  });

  it('ignores malformed SSE frames and supports cancellation', async () => {
    const adapter = createXaiAdapter({
      secrets: new MapSecretStore({ XAI_API_KEY: KEY }),
      timeoutMs: 5_000,
      baseUrl: 'https://api.x.ai/v1',
      transport: transportFor(() => ({
        status: 200,
        body: sse(['not-json', '{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]']),
      })),
    });
    const chunks = await collect(adapter.stream('grok-4.20-fast', { prompt: 'hi' }));
    expect(chunks.some((chunk) => chunk.type === 'warning')).toBe(true);
    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([{ type: 'text', text: 'ok' }]);

    const controller = new AbortController();
    controller.abort();
    await expect(collect(adapter.stream('grok-4.6', { prompt: 'hi', signal: controller.signal }))).rejects.toThrow(
      /aborted/i,
    );
  });

  it('marks xai unavailable without credentials rather than crashing startup', () => {
    const plane = createExecutionPlane({ mode: 'live', env: {}, secrets: new MapSecretStore({}) });
    expect(plane.available).not.toContain('xai');
    expect(plane.health.xai).toBe('unavailable');
  });
});
