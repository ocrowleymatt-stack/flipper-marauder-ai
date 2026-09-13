import { describe, expect, it } from 'vitest';
import { collect, deferred, fakeClock } from './index.js';

describe('fakeClock', () => {
  it('starts at a fixed instant and only moves when told', () => {
    const clock = fakeClock('2026-09-13T18:53:00.000Z');
    expect(clock.nowIso()).toBe('2026-09-13T18:53:00.000Z');
    const before = clock.now();
    clock.advance(1500);
    expect(clock.now() - before).toBe(1500);
    clock.set(0);
    expect(clock.nowIso()).toBe('1970-01-01T00:00:00.000Z');
  });

  it('rejects nonsense', () => {
    const clock = fakeClock();
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.set('not a date')).toThrow(RangeError);
  });
});

describe('collect', () => {
  it('drains async iterables in order', async () => {
    async function* gen() {
      yield 1;
      yield 2;
      yield 3;
    }
    expect(await collect(gen())).toEqual([1, 2, 3]);
  });

  it('accepts sync iterables too', async () => {
    expect(await collect(new Set(['a', 'b']))).toEqual(['a', 'b']);
  });

  it('propagates errors from the source', async () => {
    async function* failing() {
      yield 1;
      throw new Error('boom');
    }
    await expect(collect(failing())).rejects.toThrow('boom');
  });
});

describe('deferred', () => {
  it('resolves from outside', async () => {
    const d = deferred<number>();
    expect(d.settled).toBe(false);
    d.resolve(42);
    expect(d.settled).toBe(true);
    await expect(d.promise).resolves.toBe(42);
  });

  it('rejects from outside', async () => {
    const d = deferred();
    d.reject(new Error('nope'));
    expect(d.settled).toBe(true);
    await expect(d.promise).rejects.toThrow('nope');
  });
});
