export const PACKAGE_NAME = '@atlas/testing' as const;

export interface FakeClock {
  now(): number;
  nowIso(): string;
  advance(ms: number): void;
  set(epochMs: number | Date | string): void;
}

/**
 * A manually advanced clock. Inject `clock.now` wherever code accepts a `now: () => number`
 * (for example `newId(kind, { now: clock.now })`).
 */
export function fakeClock(start: number | Date | string = '2026-01-01T00:00:00.000Z'): FakeClock {
  let current = toEpochMs(start);
  return {
    now: () => current,
    nowIso: () => new Date(current).toISOString(),
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`cannot advance clock by ${ms}`);
      current += ms;
    },
    set(epoch) {
      current = toEpochMs(epoch);
    },
  };
}

function toEpochMs(value: number | Date | string): number {
  const ms = typeof value === 'number' ? value : new Date(value).getTime();
  if (!Number.isFinite(ms)) throw new RangeError(`invalid clock value: ${String(value)}`);
  return ms;
}

/** Drain an async (or sync) iterable into an array. */
export async function collect<T>(source: AsyncIterable<T> | Iterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

/** A promise with its resolve/reject exposed, for driving async code from a test. */
export function deferred<T = void>(): Deferred<T> {
  let settled = false;
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value) {
      settled = true;
      resolve(value);
    },
    reject(reason) {
      settled = true;
      reject(reason);
    },
  };
}
