import { describe, expect, it } from 'vitest';
import {
  closeAsyncIteratorBounded,
  iterateUntilAborted,
  ITERATOR_TEARDOWN_BUDGET_MS,
} from '../src/async-iterator.ts';

describe('bounded async iterator teardown', () => {
  it('does not hang when return() never settles', async () => {
    const iterator = {
      async return() {
        await new Promise(() => undefined);
        return { done: true as const, value: undefined };
      },
    };
    const started = Date.now();
    await closeAsyncIteratorBounded(iterator, 40);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('is safe to close an iterator that has no return()', async () => {
    await closeAsyncIteratorBounded({});
    await closeAsyncIteratorBounded(undefined);
  });

  it('stops waiting on pending next() once abort fires and still finalizes the iterator', async () => {
    const controller = new AbortController();
    let nextPending = false;
    let returned = 0;
    const iterable: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            nextPending = true;
            await new Promise(() => undefined);
            return { done: true, value: undefined };
          },
          async return() {
            returned += 1;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const collected: string[] = [];
    const consume = (async () => {
      for await (const item of iterateUntilAborted(iterable, controller.signal)) {
        collected.push(item);
      }
    })();
    const deadline = Date.now() + 1_000;
    while (!nextPending && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(nextPending).toBe(true);
    const started = Date.now();
    controller.abort();
    await consume;
    expect(Date.now() - started).toBeLessThan(ITERATOR_TEARDOWN_BUDGET_MS * 4);
    expect(collected).toEqual([]);
    expect(returned).toBeGreaterThanOrEqual(1);
  });
});
