import { afterEach, describe, expect, it } from 'vitest';
import { FetchTransport, iterableFromReadable, readAllText } from '../src/transport.ts';

describe('FetchTransport keeps abort attached through response streaming', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('times out a stalled body after headers return', async () => {
    globalThis.fetch = async (_url, init) => {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener(
            'abort',
            () => {
              try {
                controller.error(signal.reason ?? new Error('aborted'));
              } catch {
                // already errored
              }
            },
            { once: true },
          );
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } });
    };

    const transport = new FetchTransport(60_000);
    const started = Date.now();
    const response = await transport.send({
      url: 'https://example.test/stream',
      method: 'POST',
      headers: { accept: 'text/event-stream' },
      timeoutMs: 80,
    });
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(80);
    await expect(readAllText(response.stream)).rejects.toThrow(/timed out|abort/i);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('cancels the reader when the consumer stops early', async () => {
    let cancelled = false;
    globalThis.fetch = async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello'));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } });
    };
    const transport = new FetchTransport(5_000);
    const response = await transport.send({
      url: 'https://example.test/partial',
      method: 'GET',
      headers: {},
    });
    const iterator = response.stream[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(cancelled).toBe(true);
  });

  it('cancels iterableFromReadable when iteration is abandoned', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const gen = iterableFromReadable(stream);
    await gen.next();
    await gen.return(undefined);
    expect(cancelled).toBe(true);
  });
});
