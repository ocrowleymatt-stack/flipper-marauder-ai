import { describe, expect, it } from 'vitest';
import type { RouteDecision, StreamChunk } from '@atlas-vnext/contracts';
import { CircuitBreaker, ExecutionBroker, type ProviderAdapter } from '@atlas-vnext/execution';

function decision(chain: string[]): RouteDecision {
  const [primary] = chain;
  const [provider, model] = (primary ?? 'openai/gpt').split('/');
  return {
    target: 'nexus/fast',
    resolvedRouteId: primary ?? 'openai/gpt',
    provider: provider ?? 'openai',
    model: model ?? 'gpt',
    candidateChain: chain,
    localOnly: false,
    decisionReason: 'test',
    traceId: 'trc_test',
    evaluatedAt: new Date().toISOString(),
  };
}

describe('Execution broker (transport, retry, streaming)', () => {
  it('exports a circuit breaker from the execution layer', () => {
    const breaker = new CircuitBreaker(2, 60_000);
    expect(breaker.isOpen()).toBe(false);
    breaker.failure();
    expect(breaker.isOpen()).toBe(false);
    breaker.failure();
    expect(breaker.isOpen()).toBe(true);
    breaker.success();
    expect(breaker.isOpen()).toBe(false);
  });

  it('fails over to the next candidate before visible text', async () => {
    const broker = new ExecutionBroker(1);
    const failing: ProviderAdapter = {
      providerId: 'openai',
      async *stream() {
        throw new Error('timeout before tokens');
      },
    };
    const ok: ProviderAdapter = {
      providerId: 'ollama',
      async *stream() {
        yield { type: 'text', text: 'recovered' };
      },
    };
    broker.register(failing);
    broker.register(ok);

    const chunks: StreamChunk[] = [];
    for await (const chunk of broker.execute(decision(['openai/gpt-4o', 'ollama/llama3.2']), { prompt: 'hi' })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([{ type: 'text', text: 'recovered' }]);
  });

  it('does not start a second answer after visible text', async () => {
    const broker = new ExecutionBroker(1);
    broker.register({
      providerId: 'openai',
      async *stream() {
        yield { type: 'text', text: 'partial' };
        throw new Error('cut');
      },
    });
    broker.register({
      providerId: 'ollama',
      async *stream() {
        yield { type: 'text', text: 'contradiction' };
      },
    });

    const chunks: StreamChunk[] = [];
    await expect(async () => {
      for await (const chunk of broker.execute(decision(['openai/gpt-4o', 'ollama/llama3.2']), { prompt: 'hi' })) {
        chunks.push(chunk);
      }
    }).rejects.toThrow('cut');
    expect(chunks).toEqual([{ type: 'text', text: 'partial' }]);
  });

  it('skips a missing adapter and uses the next candidate', async () => {
    const broker = new ExecutionBroker(1);
    broker.register({
      providerId: 'ollama',
      async *stream() {
        yield { type: 'text', text: 'local' };
      },
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of broker.execute(decision(['openai/gpt-4o', 'ollama/llama3.2']), { prompt: 'hi' })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([{ type: 'text', text: 'local' }]);
  });

  it('remains usable after a provider adapter exception', async () => {
    const broker = new ExecutionBroker(1);
    broker.register({
      providerId: 'openai',
      async *stream() {
        throw new Error('boom');
      },
    });
    await expect(async () => {
      for await (const _chunk of broker.execute(decision(['openai/gpt-4o']), { prompt: 'hi' })) {
        // drain
      }
    }).rejects.toThrow(/boom|no adapter|Execution failed/);
    broker.register({
      providerId: 'gemini',
      async *stream() {
        yield { type: 'text', text: 'ok' };
      },
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of broker.execute(decision(['gemini/flash']), { prompt: 'hi' })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('buffers tool calls until the stream completes', async () => {
    const broker = new ExecutionBroker(1);
    broker.register({
      providerId: 'openai',
      async *stream() {
        yield { type: 'tool_call', call: { id: 'c1', toolId: 'search', arguments: { q: 'atlas' } } };
        yield { type: 'text', text: 'thinking' };
      },
    });

    const chunks: StreamChunk[] = [];
    for await (const chunk of broker.execute(decision(['openai/gpt-4o']), { prompt: 'search' })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      { type: 'text', text: 'thinking' },
      { type: 'tool_call', call: { id: 'c1', toolId: 'search', arguments: { q: 'atlas' } } },
    ]);
  });

  it('does not treat usage metadata as visible assistant output', async () => {
    const broker = new ExecutionBroker(1);
    broker.register({
      providerId: 'openai',
      async *stream() {
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } };
        throw new Error('died before text');
      },
    });
    broker.register({
      providerId: 'ollama',
      async *stream() {
        yield { type: 'text', text: 'fallback' };
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      },
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of broker.execute(decision(['openai/gpt-4o', 'ollama/llama3.2']), { prompt: 'hi' })) {
      chunks.push(chunk);
    }
    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([{ type: 'text', text: 'fallback' }]);
  });
});
