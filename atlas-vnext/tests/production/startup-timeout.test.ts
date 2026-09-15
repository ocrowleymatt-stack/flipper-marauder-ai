import { describe, expect, it } from 'vitest';
import { bootSpine, StartupTimeoutError, withStartupDeadline } from '../../apps/host/src/startup.ts';
import type { Spine } from '../../apps/host/src/compose.ts';

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
