export class StartupTimeoutError extends Error {
  constructor(readonly budgetMs: number) {
    super(`Host startup exceeded the configured ATLAS_STARTUP_TIMEOUT_MS deadline (${budgetMs}ms).`);
    this.name = 'StartupTimeoutError';
  }
}

export function throwIfStartupAborted(signal: AbortSignal | undefined, budgetMs = 0): void {
  if (signal?.aborted) throw new StartupTimeoutError(budgetMs);
}

export async function raceStartup<T>(
  signal: AbortSignal | undefined,
  work: Promise<T>,
  budgetMs = 0,
): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) throw new StartupTimeoutError(budgetMs);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new StartupTimeoutError(budgetMs));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Race a closeable open against the startup deadline.
 *
 * If the deadline fires while `work` is still pending, a later successful
 * result is closed exactly once. A later failed open is ignored. Adopting the
 * result on success does not close it. Cleanup is idempotent: `closeIfPossible`
 * swallows close errors, and a second discard is a no-op once closed.
 */
export async function raceStartupCloseable<T>(
  signal: AbortSignal | undefined,
  work: Promise<T>,
  budgetMs = 0,
): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    void work.then(closeIfPossible, () => undefined);
    throw new StartupTimeoutError(budgetMs);
  }
  try {
    return await raceStartup(signal, work, budgetMs);
  } catch (err) {
    void work.then(closeIfPossible, () => undefined);
    throw err;
  }
}

/**
 * One coherent startup deadline covering the whole `work` callback.
 * Nested stages share this signal; they do not each receive a fresh budget.
 */
export async function withStartupDeadline<T>(
  budgetMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let produced: T | undefined;
  const timer = setTimeout(() => controller.abort(), Math.max(1, budgetMs));
  const timeout = new Promise<never>((_, reject) => {
    const fail = (): void => reject(new StartupTimeoutError(budgetMs));
    if (controller.signal.aborted) fail();
    else controller.signal.addEventListener('abort', fail, { once: true });
  });
  const workPromise = work(controller.signal).then((value) => {
    produced = value;
    return value;
  });
  try {
    const result = await Promise.race([workPromise, timeout]);
    return result;
  } catch (err) {
    controller.abort();
    await Promise.race([
      workPromise.then(closeIfPossible, () => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
    if (produced) await closeIfPossible(produced);
    throw err instanceof StartupTimeoutError ? err : err;
  } finally {
    clearTimeout(timer);
  }
}

export async function closeIfPossible(value: unknown): Promise<void> {
  if (!value || typeof value !== 'object') return;
  const close = (value as { close?: unknown }).close;
  if (typeof close === 'function') {
    await (close as () => Promise<void>).call(value).catch(() => undefined);
  }
}
