import { describe, expect, it } from 'vitest';
import {
  MemoryRunPodClient,
  MemoryRuntimeStateStore,
  RuntimeObserver,
  RuntimeScheduler,
  emptyRuntime,
  type RuntimeClock,
} from '@atlas-vnext/execution';

class ManualClock implements RuntimeClock {
  current = 1_700_000_000_000;

  now(): number {
    return this.current;
  }

  iso(at = this.current): string {
    return new Date(at).toISOString();
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Execution aborted.');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.current += ms;
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, 1);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Execution aborted.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

function harness(overrides: { idleShutdownSeconds?: number; client?: MemoryRunPodClient; store?: MemoryRuntimeStateStore } = {}) {
  const client = overrides.client ?? new MemoryRunPodClient();
  if (!client.pods.has('pod-shared')) {
    client.seed({ id: 'pod-shared', desiredStatus: 'EXITED' });
  }
  const clock = new ManualClock();
  const observer = new RuntimeObserver();
  const store = overrides.store ?? new MemoryRuntimeStateStore();
  const scheduler = new RuntimeScheduler({
    client,
    store,
    clock,
    observer,
    podId: 'pod-shared',
    maxActivePods: 1,
    idleShutdownSeconds: overrides.idleShutdownSeconds ?? 30,
    warmTimeoutMs: 5_000,
    pollIntervalMs: 10,
  });
  return { client, clock, observer, store, scheduler };
}

describe('RunPod shared runtime scheduler', () => {
  it('starts a stopped pod, leases, executes, then idles and auto-stops', async () => {
    const { client, clock, observer, scheduler } = harness({ idleShutdownSeconds: 5 });
    const lease = await scheduler.acquire({ id: 'job-1', profile: 'llm' });
    expect(client.startCalls).toEqual(['pod-shared']);
    expect(scheduler.snapshot().runtime.state).toBe('busy');
    expect(scheduler.snapshot().runtime.lease?.jobId).toBe('job-1');
    await scheduler.release(lease.id);
    expect(scheduler.snapshot().runtime.state).toBe('idle');
    expect(scheduler.snapshot().runtime.idleSince).toBeTruthy();
    clock.advance(6_000);
    await scheduler.tick();
    expect(client.stopCalls).toEqual(['pod-shared']);
    expect(scheduler.snapshot().runtime.state).toBe('stopped');
    expect(scheduler.snapshot().runtime.stopReason).toMatch(/idle_timeout/);
    expect(observer.list().some((event) => event.type === 'stopped')).toBe(true);
    expect(observer.list().every((event) => !JSON.stringify(event).includes('RUNPOD_API_KEY'))).toBe(true);
  });

  it('queues a second job instead of starting another pod while busy', async () => {
    const { client, scheduler } = harness();
    const first = await scheduler.acquire({ id: 'job-a', profile: 'llm' });
    const pending = scheduler.acquire({ id: 'job-b', profile: 'llm' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.startCalls).toEqual(['pod-shared']);
    expect(scheduler.snapshot().runtime.queue.some((job) => job.id === 'job-b' && job.status === 'waiting_runtime')).toBe(
      true,
    );
    await scheduler.release(first.id);
    const second = await pending;
    expect(second.jobId).toBe('job-b');
    expect(client.startCalls).toHaveLength(1);
    await scheduler.release(second.id);
  });

  it('cancels idle shutdown when new work arrives during grace', async () => {
    const { client, scheduler } = harness({ idleShutdownSeconds: 60 });
    const first = await scheduler.acquire({ id: 'job-1', profile: 'llm' });
    await scheduler.release(first.id);
    expect(scheduler.snapshot().runtime.state).toBe('idle');
    const second = await scheduler.acquire({ id: 'job-2', profile: 'llm' });
    expect(client.stopCalls).toEqual([]);
    expect(client.startCalls).toEqual(['pod-shared']);
    expect(scheduler.snapshot().runtime.state).toBe('busy');
    expect(scheduler.snapshot().runtime.idleSince).toBeNull();
    await scheduler.release(second.id);
  });

  it('enforces max active pods = 1 and never creates a second pod', async () => {
    const client = new MemoryRunPodClient();
    client.seed({ id: 'pod-shared', desiredStatus: 'RUNNING' });
    client.seed({ id: 'pod-extra', desiredStatus: 'RUNNING' });
    const { scheduler } = harness({ client });
    await scheduler.reconcile();
    expect(client.stopCalls).toContain('pod-extra');
    expect(client.createCalls).toBe(0);
    const lease = await scheduler.acquire({ id: 'job-1', profile: 'llm' });
    expect(new Set(client.startCalls)).toEqual(new Set());
    await scheduler.release(lease.id);
  });

  it('recovers after crash: rediscovers the running pod, drops orphaned lease, does not double-start', async () => {
    const client = new MemoryRunPodClient();
    client.seed({ id: 'pod-shared', desiredStatus: 'RUNNING' });
    const persisted = emptyRuntime('2026-09-14T00:00:00.000Z', 'pod-shared');
    persisted.state = 'busy';
    persisted.lease = {
      id: 'lease_old',
      jobId: 'job-crashed',
      profile: 'llm',
      acquiredAt: '2026-09-14T00:00:00.000Z',
      releasedAt: null,
    };
    persisted.queue = [{ id: 'job-queued', profile: 'llm', enqueuedAt: '2026-09-14T00:00:01.000Z', status: 'waiting_runtime' }];
    const store = new MemoryRuntimeStateStore(persisted);
    const { scheduler } = harness({ client, store, idleShutdownSeconds: 60 });
    const recovered = await scheduler.reconcile();
    expect(recovered.state).toBe('ready');
    expect(recovered.lease).toBeNull();
    expect(recovered.queue.some((job) => job.id === 'job-queued')).toBe(true);
    expect(client.startCalls).toEqual([]);
    const lease = await scheduler.acquire({ id: 'job-queued', profile: 'llm' });
    expect(lease.jobId).toBe('job-queued');
    expect(client.startCalls).toEqual([]);
    await scheduler.release(lease.id);
  });

  it('shuts down orphaned paid capacity that is genuinely idle after restart', async () => {
    const client = new MemoryRunPodClient();
    client.seed({ id: 'pod-shared', desiredStatus: 'RUNNING' });
    const persisted = emptyRuntime('2026-09-14T00:00:00.000Z', 'pod-shared');
    persisted.state = 'idle';
    persisted.idleSince = '2000-01-01T00:00:00.000Z';
    persisted.startedAt = '2000-01-01T00:00:00.000Z';
    const store = new MemoryRuntimeStateStore(persisted);
    const { scheduler } = harness({ client, store, idleShutdownSeconds: 1 });
    const recovered = await scheduler.reconcile();
    expect(recovered.state).toBe('stopped');
    expect(client.stopCalls).toContain('pod-shared');
    expect(client.startCalls).toEqual([]);
  });

  it('does not start RunPod during composition/reconcile when stopped', async () => {
    const { client, scheduler } = harness();
    await scheduler.reconcile();
    expect(client.startCalls).toEqual([]);
    expect(scheduler.snapshot().runtime.state).toBe('stopped');
  });
});
