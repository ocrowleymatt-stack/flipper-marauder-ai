/** Bound for iterator.return() so a non-cooperative provider cannot hang teardown. */
export const ITERATOR_TEARDOWN_BUDGET_MS = 100;

export function delayUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Close an async iterator without waiting forever. `return()` is attempted once;
 * a hanging provider is abandoned after `budgetMs`. Safe to call repeatedly.
 */
export async function closeAsyncIteratorBounded(
  iterator: { return?: (value?: unknown) => Promise<IteratorResult<unknown, unknown>> | IteratorResult<unknown, unknown> } | undefined,
  budgetMs = ITERATOR_TEARDOWN_BUDGET_MS,
): Promise<void> {
  if (!iterator || typeof iterator.return !== 'function') return;
  const closing = Promise.resolve(iterator.return(undefined)).then(
    () => undefined,
    () => undefined,
  );
  if (budgetMs <= 0) {
    void closing;
    return;
  }
  await Promise.race([closing, delayUnref(budgetMs)]);
}

/**
 * Drive an async iterable until it completes or `signal` aborts. Abort wins over a
 * pending `next()` so a provider that ignores abort cannot strand the consumer.
 * The underlying iterator is always finalized with a bounded `return()`.
 */
export async function* iterateUntilAborted<T>(iterable: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    while (!signal.aborted) {
      const next = Promise.resolve(iterator.next()).then(
        (result) => ({ kind: 'next' as const, result }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );
      const winner = await Promise.race([next, aborted.then(() => ({ kind: 'aborted' as const }))]);
      if (winner.kind === 'aborted' || signal.aborted) {
        break;
      }
      if (winner.kind === 'error') {
        throw winner.error;
      }
      if (winner.result.done) {
        return;
      }
      yield winner.result.value;
    }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    await closeAsyncIteratorBounded(iterator);
  }
}
