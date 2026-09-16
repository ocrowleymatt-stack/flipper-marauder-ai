import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootSpine,
  raceStartupCloseable,
  StartupTimeoutError,
  withStartupDeadline,
} from '../../apps/host/src/startup.ts';
import { composeSpine, type Spine } from '../../apps/host/src/compose.ts';
import type { PlatformPersistence } from '@atlas-vnext/persistence';

function closable(label: string, closed: string[]): Spine {
  return {
    close: async () => {
      closed.push(label);
    },
  } as unknown as Spine;
}

describe('P2: ATLAS_STARTUP_TIMEOUT_MS governs the full startup boundary', () => {
  it('completes successful startup inside the deadline', async () => {
    const closed: string[] = [];
    const spine = await withStartupDeadline(200, async () => closable('ok', closed));
    expect(spine).toBeTruthy();
    expect(closed).toEqual([]);
    await spine.close();
  });

  it('fails closed when composition stalls past the shared deadline', async () => {
    const closed: string[] = [];
    const started = Date.now();
    await expect(
      withStartupDeadline(40, async (signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              closed.push('compose');
              reject(new StartupTimeoutError(40));
            },
            { once: true },
          );
        });
        return closable('late', closed);
      }),
    ).rejects.toBeInstanceOf(StartupTimeoutError);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(closed).toContain('compose');
  });

  it('fails closed when a readiness/dependency probe stalls', async () => {
    const closed: string[] = [];
    await expect(
      bootSpine({
        dataPath: '/tmp/atlas-startup-ready',
        mode: 'mock',
        env: { ATLAS_STARTUP_TIMEOUT_MS: '40' },
        production: true,
        compose: async () =>
          ({
            healthProbe: {
              live: () => true,
              dependencies: () => new Promise(() => undefined),
            },
            close: async () => {
              closed.push('spine');
            },
          }) as unknown as Spine,
      }),
    ).rejects.toBeInstanceOf(StartupTimeoutError);
    expect(closed).toContain('spine');
  });

  it('does not grant each startup stage a fresh copy of the full timeout', async () => {
    const closed: string[] = [];
    const started = Date.now();
    await expect(
      bootSpine({
        dataPath: '/tmp/atlas-startup-stages',
        mode: 'mock',
        env: { ATLAS_STARTUP_TIMEOUT_MS: '80' },
        production: true,
        compose: async ({ signal }) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 50);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(new StartupTimeoutError(80));
              },
              { once: true },
            );
          });
          return {
            healthProbe: {
              live: () => true,
              dependencies: () =>
                new Promise((_, reject) => {
                  const timer = setTimeout(() => undefined, 50);
                  signal?.addEventListener(
                    'abort',
                    () => {
                      clearTimeout(timer);
                      reject(new StartupTimeoutError(80));
                    },
                    { once: true },
                  );
                }),
            },
            close: async () => {
              closed.push('spine');
            },
          } as unknown as Spine;
        },
      }),
    ).rejects.toBeInstanceOf(StartupTimeoutError);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(closed).toContain('spine');
  });

  it('cleans up resources opened before a startup timeout', async () => {
    const closed: string[] = [];
    await expect(
      withStartupDeadline(30, async (signal) => {
        const resource = closable('resource', closed);
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              void resource.close();
              reject(new StartupTimeoutError(30));
            },
            { once: true },
          );
        });
        return resource;
      }),
    ).rejects.toBeInstanceOf(StartupTimeoutError);
    expect(closed).toContain('resource');
  });
});

function delayedCloseable(label: string, closed: string[], delayMs: number, fail = false): Promise<{ close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (fail) {
        reject(new Error(`${label} failed to open`));
        return;
      }
      let closedOnce = false;
      resolve({
        close: async () => {
          if (closedOnce) return;
          closedOnce = true;
          closed.push(label);
        },
      });
    }, delayMs);
  });
}

describe('P2: close persistence that finishes opening after startup timeout', () => {
  it('times out before open completes without waiting for the pending open', async () => {
    const closed: string[] = [];
    const controller = new AbortController();
    const opening = delayedCloseable('late-open', closed, 80);
    const started = Date.now();
    setTimeout(() => controller.abort(), 30);
    await expect(raceStartupCloseable(controller.signal, opening, 30)).rejects.toBeInstanceOf(StartupTimeoutError);
    expect(Date.now() - started).toBeLessThan(200);
    expect(closed).toEqual([]);
    await opening.then((value) => value.close(), () => undefined);
  });

  it('closes a late successful open after the startup deadline has already failed', async () => {
    const closed: string[] = [];
    const controller = new AbortController();
    const opening = delayedCloseable('late-success', closed, 80);
    setTimeout(() => controller.abort(), 20);
    await expect(raceStartupCloseable(controller.signal, opening, 20)).rejects.toBeInstanceOf(StartupTimeoutError);
    expect(closed).toEqual([]);
    await opening;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toEqual(['late-success']);
    const handle = await opening;
    await handle.close();
    expect(closed).toEqual(['late-success']);
  });

  it('ignores a late failed open after the startup deadline has already failed', async () => {
    const closed: string[] = [];
    const controller = new AbortController();
    const opening = delayedCloseable('late-fail', closed, 80, true);
    setTimeout(() => controller.abort(), 20);
    await expect(raceStartupCloseable(controller.signal, opening, 20)).rejects.toBeInstanceOf(StartupTimeoutError);
    await opening.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toEqual([]);
  });

  it('adopts a successful open during normal startup and does not close it', async () => {
    const closed: string[] = [];
    const controller = new AbortController();
    const opening = delayedCloseable('adopted', closed, 10);
    const handle = await raceStartupCloseable(controller.signal, opening, 200);
    expect(closed).toEqual([]);
    await handle.close();
    expect(closed).toEqual(['adopted']);
  });

  it('closes persistence opened by composeSpine after the startup signal aborts', async () => {
    const closed: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'atlas-startup-persist-'));
    let release!: (value: PlatformPersistence) => void;
    const pending = new Promise<PlatformPersistence>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    const composing = composeSpine({
      dataPath: join(dir, 'state.json'),
      mode: 'mock',
      casRoot: join(dir, 'cas'),
      persistence: {
        mode: 'memory',
        production: false,
        databaseUrl: null,
        poolMax: 4,
        idleTimeoutMs: 10_000,
        connectionTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
        filePath: null,
        defaultTenantId: 'tenant_a',
      },
      openPersistence: async () => pending,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 40);
    await expect(composing).rejects.toBeInstanceOf(StartupTimeoutError);
    let closedOnce = false;
    release({
      close: async () => {
        if (closedOnce) return;
        closedOnce = true;
        closed.push('compose-persistence');
      },
    } as PlatformPersistence);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(closed).toEqual(['compose-persistence']);
  });
});

