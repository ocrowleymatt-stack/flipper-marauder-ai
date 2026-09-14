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
    locality: 'public_cloud',
    runtimeClass: 'always_available',
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

  it('mountain-compat: fails over to the next candidate before visible text', async () => {
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

  it('mountain-compat: does not start a second answer after visible text', async () => {
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

  it('mountain-compat: buffers tool calls until the stream completes', async () => {
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

  it('mountain-compat: retries the same candidate before failover and records both attempts', async () => {
    const broker = new ExecutionBroker(2);
    let calls = 0;
    broker.register({
      providerId: 'openai',
      async *stream() {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        yield { type: 'text', text: 'second try' };
      },
    });
    const chunks: StreamChunk[] = [];
    const attempts: string[] = [];
    for await (const chunk of broker.execute(decision(['openai/gpt-4o']), { prompt: 'hi' }, {
      onAttempt: (attempt) => attempts.push(`${attempt.outcome}:${attempt.provider}`),
    })) {
      chunks.push(chunk);
    }
    expect(calls).toBe(2);
    expect(chunks).toEqual([{ type: 'text', text: 'second try' }]);
    expect(attempts).toEqual(['started:openai', 'failed:openai', 'started:openai', 'succeeded:openai']);
  });

  it('skips a provider when its circuit is open', async () => {
    const broker = new ExecutionBroker(1);
    broker.register({
      providerId: 'openai',
      async *stream() {
        throw new Error('down');
      },
    });
    broker.register({
      providerId: 'ollama',
      async *stream() {
        yield { type: 'text', text: 'local' };
      },
    });
    const breaker = broker.breaker('openai');
    breaker.failure();
    breaker.failure();
    breaker.failure();
    expect(breaker.isOpen()).toBe(true);
    const chunks: StreamChunk[] = [];
    for await (const chunk of broker.execute(decision(['openai/gpt-4o', 'ollama/llama3.2']), { prompt: 'hi' })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([{ type: 'text', text: 'local' }]);
  });

  it('mountain-compat: treats reasoning deltas as visible output and refuses a second provider', async () => {
    const broker = new ExecutionBroker(1);
    broker.register({
      providerId: 'openai',
      async *stream() {
        yield { type: 'reasoning', text: 'thinking' };
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
    expect(chunks).toEqual([{ type: 'reasoning', text: 'thinking' }]);
  });

  it('does not treat provider warnings as visible output', async () => {
    const broker = new ExecutionBroker(1);
    broker.register({
      providerId: 'openai',
      async *stream() {
        yield { type: 'warning', message: 'rate limit approaching', provider: 'openai' };
        throw new Error('died after warning');
      },
    });
    broker.register({
      providerId: 'ollama',
      async *stream() {
        yield { type: 'text', text: 'ok' };
      },
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of broker.execute(decision(['openai/gpt-4o', 'ollama/llama3.2']), { prompt: 'hi' })) {
      chunks.push(chunk);
    }
    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([{ type: 'text', text: 'ok' }]);
    expect(chunks.some((chunk) => chunk.type === 'warning')).toBe(true);
  });
});
