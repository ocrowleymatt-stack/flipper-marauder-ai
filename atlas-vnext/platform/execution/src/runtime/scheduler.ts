import { randomUUID } from 'node:crypto';
import { RuntimeObserver } from './observer.ts';
import {
  emptyRuntime,
  podIsActive,
  profilesCompatible,
  RUNTIME_PROFILE_CATALOGUE,
  SystemRuntimeClock,
  type RunPodClient,
  type RunPodLease,
  type RunPodRuntime,
  type RuntimeClock,
  type RuntimeEvent,
  type RuntimeProfileId,
  type RuntimeSnapshot,
  type RuntimeState,
  type RuntimeStateStore,
} from './types.ts';

export interface RuntimeSchedulerOptions {
  client: RunPodClient;
  store: RuntimeStateStore;
  clock?: RuntimeClock;
  observer?: RuntimeObserver;
  podId: string | null;
  maxActivePods?: number;
  idleShutdownSeconds?: number;
  warmTimeoutMs?: number;
  pollIntervalMs?: number;
  inferencePort?: number;
}

export interface RuntimeJobRequest {
  id: string;
  profile: RuntimeProfileId;
  signal?: AbortSignal;
}

/**
 * One shared paid RunPod. Starts on demand, leases exclusively, queues
 * overflow, and shuts down after a configurable idle grace. Never creates
 * a second pod for latency or per-dungeon isolation.
 */
export class RuntimeScheduler {
  private runtime: RunPodRuntime;
  private readonly clock: RuntimeClock;
  private readonly observer: RuntimeObserver;
  private readonly maxActivePods: number;
  private readonly idleShutdownSeconds: number;
  private readonly warmTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private tail: Promise<void> = Promise.resolve();
  private changeWaiters: Array<() => void> = [];
  private starting = false;

  constructor(private readonly options: RuntimeSchedulerOptions) {
    this.clock = options.clock ?? new SystemRuntimeClock();
    this.observer = options.observer ?? new RuntimeObserver();
    this.maxActivePods = Math.min(1, Math.max(1, options.maxActivePods ?? 1));
    this.idleShutdownSeconds = options.idleShutdownSeconds ?? 120;
    this.warmTimeoutMs = options.warmTimeoutMs ?? 180_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.runtime = emptyRuntime(this.clock.iso(), options.podId);
  }

  snapshot(): RuntimeSnapshot {
    return this.observer.snapshot({
      runtime: structuredClone(this.runtime),
      maxActivePods: this.maxActivePods,
      idleShutdownSeconds: this.idleShutdownSeconds,
    });
  }

  inferenceBaseUrl(explicit?: string | null): string | null {
    if (explicit) return explicit.replace(/\/+$/, '');
    if (!this.runtime.podId) return null;
    const port = this.options.inferencePort ?? 8000;
    return `https://${this.runtime.podId}-${port}.proxy.runpod.net/v1`;
  }

  async reconcile(): Promise<RunPodRuntime> {
    return this.withLock(async () => {
      const loaded = await this.options.store.load();
      if (loaded) {
        this.runtime = {
          ...loaded,
          podId: loaded.podId ?? this.options.podId,
          queue: loaded.queue ?? [],
        };
      } else {
        this.runtime.podId = this.options.podId;
      }

      let pods: Awaited<ReturnType<RunPodClient['listPods']>> = [];
      try {
        pods = await this.options.client.listPods();
      } catch (err) {
        this.runtime.lastError = err instanceof Error ? err.message : String(err);
        this.runtime.healthFailure = this.runtime.lastError;
        await this.persist('reconcile_probe_failed');
        return structuredClone(this.runtime);
      }

      const active = pods.filter((pod) => podIsActive(pod));
      const configured = this.runtime.podId ? pods.find((pod) => pod.id === this.runtime.podId) : undefined;
      const discovered = configured ?? active[0];

      if (discovered) {
        this.runtime.podId = discovered.id;
        if (typeof discovered.costPerHr === 'number' && this.runtime.startedAt) {
          const hours = Math.max(0, this.clock.now() - Date.parse(this.runtime.startedAt)) / 3_600_000;
          this.runtime.costUsd = Number((discovered.costPerHr * hours).toFixed(4));
        }
      }

      if (discovered && podIsActive(discovered)) {
        if (this.runtime.lease) {
          this.runtime.lease = null;
          this.event('lease_orphaned', 'Recovered running pod after process restart; in-flight lease cannot be resumed.');
        }
        this.runtime.state = this.runtime.queue.length > 0 ? 'ready' : 'idle';
        this.runtime.idleSince = this.runtime.idleSince ?? this.clock.iso();
        this.runtime.readyAt = this.runtime.readyAt ?? this.clock.iso();
        this.runtime.startupFailure = null;
        await this.maybeIdleStop('reconcile');
      } else {
        if (this.runtime.state !== 'stopped' && this.runtime.state !== 'failed') {
          this.runtime.stopReason = this.runtime.stopReason ?? 'rediscovered_stopped';
        }
        this.runtime.state = this.runtime.lease ? 'failed' : 'stopped';
        this.runtime.lease = null;
        this.runtime.idleSince = null;
      }

      if (active.length > this.maxActivePods) {
        await this.stopExtras(active);
      }

      await this.persist('reconcile');
      this.notify();
      return structuredClone(this.runtime);
    });
  }

  async acquire(job: RuntimeJobRequest): Promise<RunPodLease> {
    while (true) {
      if (job.signal?.aborted) throw new Error('Execution aborted.');
      const granted = await this.withLock(() => this.tryAcquire(job));
      if (granted) return granted;
      await Promise.race([this.waitForChange(job.signal), this.clock.sleep(this.pollIntervalMs, job.signal)]);
    }
  }

  async release(leaseId: string): Promise<void> {
    await this.withLock(async () => {
      if (!this.runtime.lease || this.runtime.lease.id !== leaseId) return;
      this.runtime.lease = { ...this.runtime.lease, releasedAt: this.clock.iso() };
      const released = this.runtime.lease;
      this.runtime.lease = null;
      this.event('lease_released', undefined, { leaseId, jobId: released.jobId });
      if (this.runtime.queue.length > 0) {
        this.runtime.state = 'ready';
        this.runtime.idleSince = null;
      } else {
        this.runtime.state = 'idle';
        this.runtime.idleSince = this.clock.iso();
        this.event('idle', 'Lease released; idle grace started.');
      }
      await this.persist('release');
      this.notify();
    });
    await this.tick();
  }

  async tick(): Promise<void> {
    await this.withLock(() => this.maybeIdleStop('tick'));
  }

  private async tryAcquire(job: RuntimeJobRequest): Promise<RunPodLease | null> {
    this.enqueue(job);
    if (this.runtime.lease && this.runtime.lease.jobId !== job.id) {
      this.event('queued', 'RunPod busy; job waiting_runtime without starting another pod.', {
        jobId: job.id,
      });
      return null;
    }
    if (this.runtime.lease && this.runtime.lease.jobId === job.id) {
      return this.runtime.lease;
    }
    if (this.runtime.state === 'stopping') return null;

    const ready = await this.ensureReady(job.profile);
    if (!ready) {
      if (this.runtime.startupFailure) {
        throw new Error(this.runtime.startupFailure);
      }
      return null;
    }
    const lease = this.grant(job);
    await this.persist('leased');
    return lease;
  }

  private async ensureReady(profile: RuntimeProfileId): Promise<boolean> {
    if (!this.runtime.podId && !this.options.podId) {
      this.runtime.state = 'failed';
      this.runtime.startupFailure = 'RUNPOD_POD_ID is not configured; refusing to create a pod.';
      this.runtime.lastError = this.runtime.startupFailure;
      await this.persist('missing_pod_id');
      throw new Error(this.runtime.startupFailure);
    }
    this.runtime.podId = this.runtime.podId ?? this.options.podId;

    const pods = await this.options.client.listPods();
    const active = pods.filter((pod) => podIsActive(pod));
    const ours = this.runtime.podId ? pods.find((pod) => pod.id === this.runtime.podId) : undefined;

    if (active.length >= this.maxActivePods && ours && !podIsActive(ours)) {
      const occupant = active[0];
      if (occupant) {
        this.runtime.podId = occupant.id;
        this.event('rediscovered', 'Adopted the already-running shared RunPod instead of starting another.');
      } else {
        this.event('max_capacity', 'RUNPOD_MAX_ACTIVE_PODS=1; queueing instead of starting a second pod.');
        return false;
      }
    }

    if (active.length >= this.maxActivePods && !ours) {
      this.runtime.podId = active[0]!.id;
    } else if (active[0] && !ours) {
      this.runtime.podId = active[0].id;
    }

    const current = this.runtime.podId ? await this.options.client.getPod(this.runtime.podId) : active[0] ?? null;
    if (current && podIsActive(current)) {
      this.runtime.podId = current.id;
      if (this.runtime.state === 'idle' || this.runtime.state === 'ready' || this.runtime.state === 'stopped') {
        this.runtime.state = 'ready';
        this.runtime.idleSince = null;
        this.event('idle_cancelled', 'New work arrived during idle grace; shutdown cancelled.');
      }
      if (!profilesCompatible(this.runtime.profile, profile) && RUNTIME_PROFILE_CATALOGUE[profile].requiresImageChange) {
        this.event('profile_change', `Runtime profile changing ${this.runtime.profile} → ${profile}.`);
        this.runtime.profile = profile;
        this.runtime.state = 'warming';
      }
      this.runtime.readyAt = this.runtime.readyAt ?? this.clock.iso();
      this.runtime.state = 'ready';
      await this.persist('already_ready');
      return true;
    }

    if (this.starting) return false;
    this.starting = true;
    try {
      this.runtime.state = 'starting';
      this.runtime.startedAt = this.clock.iso();
      this.runtime.stoppedAt = null;
      this.runtime.stopReason = null;
      this.runtime.idleSince = null;
      this.runtime.startupFailure = null;
      await this.persist('starting');
      this.event('starting', 'Starting the shared RunPod.');
      if (!this.runtime.podId) throw new Error('RUNPOD_POD_ID is not configured; refusing to create a pod.');
      await this.options.client.startPod(this.runtime.podId);
      this.runtime.state = 'warming';
      await this.persist('warming');
      this.event('warming', 'Waiting for RunPod to become ready.');
      const ready = await this.waitUntilRunning();
      if (!ready) {
        this.runtime.state = 'failed';
        this.runtime.startupFailure = 'Timed out waiting for RunPod to become ready.';
        this.runtime.lastError = this.runtime.startupFailure;
        await this.persist('startup_timeout');
        this.event('startup_failed', this.runtime.startupFailure);
        return false;
      }
      this.runtime.state = 'ready';
      this.runtime.readyAt = this.clock.iso();
      this.runtime.profile = profile;
      await this.persist('ready');
      this.event('ready', 'Shared RunPod is ready.');
      return true;
    } catch (err) {
      this.runtime.state = 'failed';
      this.runtime.startupFailure = err instanceof Error ? err.message : String(err);
      this.runtime.lastError = this.runtime.startupFailure;
      await this.persist('startup_failed');
      this.event('startup_failed', this.runtime.startupFailure);
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      this.starting = false;
    }
  }

  private async waitUntilRunning(): Promise<boolean> {
    const deadline = this.clock.now() + this.warmTimeoutMs;
    while (this.clock.now() < deadline) {
      if (!this.runtime.podId) return false;
      const pod = await this.options.client.getPod(this.runtime.podId);
      if (pod && podIsActive(pod) && String(pod.desiredStatus).toUpperCase().includes('RUNNING')) {
        return true;
      }
      await this.clock.sleep(this.pollIntervalMs);
    }
    return false;
  }

  private grant(job: RuntimeJobRequest): RunPodLease {
    const lease: RunPodLease = {
      id: `lease_${randomUUID()}`,
      jobId: job.id,
      profile: job.profile,
      acquiredAt: this.clock.iso(),
      releasedAt: null,
    };
    this.runtime.lease = lease;
    this.runtime.profile = job.profile;
    this.runtime.state = 'busy';
    this.runtime.queue = this.runtime.queue.filter((item) => item.id !== job.id);
    this.runtime.idleSince = null;
    this.event('leased', 'Job leased the shared RunPod.', { jobId: job.id, leaseId: lease.id });
    this.notify();
    return lease;
  }

  private enqueue(job: RuntimeJobRequest): void {
    if (this.runtime.lease?.jobId === job.id) return;
    if (this.runtime.queue.some((item) => item.id === job.id)) return;
    this.runtime.queue.push({
      id: job.id,
      profile: job.profile,
      enqueuedAt: this.clock.iso(),
      status: 'waiting_runtime',
    });
  }

  private async maybeIdleStop(reason: string): Promise<void> {
    if (this.runtime.lease || this.runtime.queue.length > 0) return;
    if (this.runtime.state !== 'idle' && this.runtime.state !== 'ready') return;
    if (!this.runtime.idleSince) {
      this.runtime.state = 'idle';
      this.runtime.idleSince = this.clock.iso();
    }
    const idleForMs = this.clock.now() - Date.parse(this.runtime.idleSince);
    if (idleForMs < this.idleShutdownSeconds * 1000) return;
    if (!this.runtime.podId) return;
    this.runtime.state = 'stopping';
    this.runtime.stoppingAt = this.clock.iso();
    this.runtime.stopReason = reason === 'tick' ? 'idle_timeout' : `idle_timeout:${reason}`;
    await this.persist('stopping');
    this.event('stopping', 'Idle grace elapsed; shutting down the shared RunPod.');
    try {
      await this.options.client.stopPod(this.runtime.podId);
    } catch (err) {
      this.runtime.lastError = err instanceof Error ? err.message : String(err);
    }
    this.runtime.state = 'stopped';
    this.runtime.stoppedAt = this.clock.iso();
    this.runtime.durationMs =
      this.runtime.startedAt != null ? this.clock.now() - Date.parse(this.runtime.startedAt) : null;
    this.runtime.idleSince = null;
    await this.persist('stopped');
    this.event('stopped', this.runtime.stopReason ?? 'stopped');
    this.notify();
  }

  private async stopExtras(
    active: Array<{ id: string }>,
  ): Promise<void> {
    const keep = this.runtime.podId ?? active[0]?.id;
    for (const pod of active) {
      if (pod.id === keep) continue;
      this.event('orphan_stop', 'Stopping extra paid capacity beyond RUNPOD_MAX_ACTIVE_PODS=1.', {
        detail: pod.id,
      });
      try {
        await this.options.client.stopPod(pod.id);
      } catch (err) {
        this.runtime.lastError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  private async persist(reason: string): Promise<void> {
    this.runtime.updatedAt = this.clock.iso();
    await this.options.store.save(structuredClone(this.runtime));
    void reason;
  }

  private event(type: string, detail?: string, extra: Partial<RuntimeEvent> = {}): void {
    this.observer.record({
      at: this.clock.iso(),
      type,
      podId: this.runtime.podId,
      state: this.runtime.state,
      profile: this.runtime.profile,
      queuedJobs: this.runtime.queue.length,
      idleSince: this.runtime.idleSince,
      stopReason: this.runtime.stopReason,
      durationMs: this.runtime.durationMs,
      costUsd: this.runtime.costUsd,
      detail,
      ...extra,
    });
  }

  private notify(): void {
    const waiters = this.changeWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  private waitForChange(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Execution aborted.'));
        return;
      }
      const onAbort = () => {
        reject(new Error('Execution aborted.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.changeWaiters.push(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return (async () => {
      await prev;
      try {
        return await fn();
      } finally {
        release();
      }
    })();
  }
}

export function isBusyState(state: RuntimeState): boolean {
  return state === 'leased' || state === 'busy';
}
