import { randomUUID } from 'node:crypto';
import { sanitizeText } from '../sanitize.ts';
import { RuntimeObserver } from './observer.ts';
import {
  CREATE_POD_REFUSED_REASON,
  emptyRuntime,
  normalizeRuntime,
  podIsActive,
  podIsRunning,
  profilesCompatible,
  RUNTIME_PROFILE_CATALOGUE,
  SCALE_OUT_DISABLED_REASON,
  SystemRuntimeClock,
  type QueuedRuntimeJob,
  type RunPodClient,
  type RunPodLease,
  type RunPodRuntime,
  type RuntimeActivity,
  type RuntimeClock,
  type RuntimeEvent,
  type RuntimeProfileId,
  type RuntimeSnapshot,
  type RuntimeState,
  type RuntimeStateStore,
  type WaitingReason,
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
  leaseTtlSeconds?: number;
  idleWatchMs?: number;
}

export interface RuntimeJobRequest {
  id: string;
  profile: RuntimeProfileId;
  workloadType?: string;
  requestedModel?: string | null;
  traceId?: string;
  signal?: AbortSignal;
}

/** Keep-warm is explicit and time-bounded; cannot silently become 24/7. */
export const MAX_KEEP_WARM_SECONDS = 3_600;

type AcquireOutcome =
  | { lease: RunPodLease; waitForWarm?: false }
  | { lease: null; waitForWarm: true }
  | { lease: null; waitForWarm?: false };

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
  private readonly leaseTtlMs: number;
  private readonly idleWatchMs: number;
  private tail: Promise<void> = Promise.resolve();
  private changeWaiters: Array<() => void> = [];
  private stopBarrier: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: RuntimeSchedulerOptions) {
    this.clock = options.clock ?? new SystemRuntimeClock();
    this.observer = options.observer ?? new RuntimeObserver();
    this.maxActivePods = 1;
    this.idleShutdownSeconds = options.idleShutdownSeconds ?? 120;
    this.warmTimeoutMs = options.warmTimeoutMs ?? 180_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.leaseTtlMs = (options.leaseTtlSeconds ?? 900) * 1000;
    this.idleWatchMs = options.idleWatchMs ?? 15_000;
    this.runtime = emptyRuntime(this.clock.iso(), options.podId);
    void options.maxActivePods;
  }

  snapshot(): RuntimeSnapshot {
    return this.observer.snapshot({
      runtime: structuredClone(this.runtime),
      maxActivePods: this.maxActivePods,
      idleShutdownSeconds: this.idleShutdownSeconds,
      scaleOutDisabled: true,
      keepWarmUntil: this.runtime.keepWarmUntil,
    });
  }

  inferenceBaseUrl(explicit?: string | null): string | null {
    if (explicit) return explicit.replace(/\/+$/, '');
    if (!this.runtime.podId) return null;
    const port = this.options.inferencePort ?? 8000;
    return `https://${this.runtime.podId}-${port}.proxy.runpod.net/v1`;
  }

  waitingMessage(jobId?: string): string {
    const queued = jobId ? this.runtime.queue.find((item) => item.id === jobId) : this.runtime.queue[0];
    const warming =
      this.runtime.state === 'stopped' ||
      this.runtime.state === 'starting' ||
      this.runtime.state === 'warming' ||
      this.runtime.state === 'stopping';
    const reason = queued?.waitingReason ?? (warming || !this.runtime.lease ? 'pod_starting' : 'pod_busy');
    return waitingCopy(reason, this.runtime.state);
  }

  /**
   * Time-bounded keep-warm override. Not an always-on default. Pass 0 to clear.
   * Deferred operational use: callers must opt in explicitly.
   */
  async requestKeepWarm(seconds: number): Promise<void> {
    await this.withLock(async () => {
      if (seconds <= 0) {
        this.runtime.keepWarmUntil = null;
        this.event('keep_warm_cleared', 'Keep-warm override cleared.');
      } else {
        const bounded = Math.min(Math.floor(seconds), MAX_KEEP_WARM_SECONDS);
        this.runtime.keepWarmUntil = this.clock.iso(this.clock.now() + bounded * 1000);
        this.event('keep_warm', `Time-bounded keep-warm until ${this.runtime.keepWarmUntil}.`);
      }
      await this.persist('keep_warm');
    });
  }

  async setActivity(activity: RuntimeActivity): Promise<void> {
    await this.withLock(async () => {
      this.runtime.activity = activity;
      if (activity !== 'none') {
        this.runtime.idleSince = null;
        if (this.runtime.state === 'idle') this.runtime.state = 'ready';
      } else if (!this.runtime.lease && this.runtime.queue.length === 0 && (this.runtime.state === 'ready' || this.runtime.state === 'idle')) {
        this.runtime.state = 'idle';
        this.runtime.idleSince = this.runtime.idleSince ?? this.clock.iso();
      }
      await this.persist('activity');
      this.notify();
    });
  }

  async heartbeat(leaseId: string): Promise<void> {
    await this.withLock(async () => {
      if (!this.runtime.lease || this.runtime.lease.id !== leaseId) return;
      const now = this.clock.now();
      this.runtime.lease = {
        ...this.runtime.lease,
        heartbeatAt: this.clock.iso(now),
        expiresAt: this.clock.iso(now + this.leaseTtlMs),
        state: 'acquired',
      };
      await this.persist('heartbeat');
    });
  }

  /** Test hook: pause between arming idle-stop and the final queue recheck. */
  deferStop(barrier: Promise<void>): void {
    this.stopBarrier = barrier;
  }

  startIdleWatch(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      void this.tick();
    }, this.idleWatchMs);
    this.idleTimer.unref?.();
  }

  stopIdleWatch(): void {
    if (!this.idleTimer) return;
    clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  async reconcile(): Promise<RunPodRuntime> {
    return this.withLock(async () => {
      const loaded = await this.options.store.load();
      if (loaded) {
        this.runtime = normalizeRuntime(loaded, this.options.podId, this.clock.iso());
      } else {
        this.runtime.podId = this.options.podId;
      }

      let pods: Awaited<ReturnType<RunPodClient['listPods']>> = [];
      try {
        pods = await this.options.client.listPods();
      } catch (err) {
        this.runtime.lastError = sanitizeText(err instanceof Error ? err.message : String(err));
        this.runtime.healthFailure = this.runtime.lastError;
        await this.persist('reconcile_probe_failed');
        this.event('health_failed', this.runtime.healthFailure);
        return structuredClone(this.runtime);
      }

      const active = pods.filter((pod) => podIsActive(pod));
      const configured = this.runtime.podId ? pods.find((pod) => pod.id === this.runtime.podId) : undefined;
      const discovered = configured ?? active[0];

      if (discovered) {
        this.runtime.podId = discovered.id;
        this.applyCost(discovered.costPerHr);
      }

      if (discovered && podIsActive(discovered)) {
        if (this.runtime.lease) {
          this.event('lease_orphaned', 'Recovered running pod after process restart; in-flight lease cannot be resumed.', {
            leaseId: this.runtime.lease.id,
            jobId: this.runtime.lease.jobId,
          });
          this.runtime.lease = null;
        }
        this.runtime.state = this.runtime.queue.length > 0 ? 'ready' : 'idle';
        this.runtime.idleSince = this.runtime.idleSince ?? this.clock.iso();
        this.runtime.readyAt = this.runtime.readyAt ?? this.clock.iso();
        this.runtime.startupFailure = null;
        this.event('rediscovered', 'Discovered already-running shared RunPod after restart.');
        await this.armIdleStop('reconcile');
        await this.commitIdleStop();
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
      const outcome = await this.withLock(() => this.tryAcquire(job));
      if (outcome.lease) return outcome.lease;
      if (outcome.waitForWarm) {
        const ready = await this.waitUntilRunning(job.signal);
        if (!ready) {
          await this.withLock(() => this.markStartupTimeout());
          throw new Error(this.runtime.startupFailure ?? 'Timed out waiting for RunPod to become ready.');
        }
        await this.withLock(async () => {
          if (this.runtime.state === 'warming' || this.runtime.state === 'starting') {
            this.runtime.state = 'ready';
            this.runtime.readyAt = this.clock.iso();
            this.runtime.startupFailure = null;
            await this.persist('ready');
            this.event('ready', 'Shared RunPod is ready.');
            this.notify();
          }
        });
        continue;
      }
      if (this.runtime.startupFailure && this.runtime.state === 'failed') {
        throw new Error(this.runtime.startupFailure);
      }
      await Promise.race([this.waitForChange(job.signal), this.clock.sleep(this.pollIntervalMs, job.signal)]);
    }
  }

  async release(leaseId: string): Promise<void> {
    await this.withLock(async () => {
      if (!this.runtime.lease || this.runtime.lease.id !== leaseId) return;
      this.runtime.lease = { ...this.runtime.lease, releasedAt: this.clock.iso(), state: 'released' };
      const released = this.runtime.lease;
      this.runtime.lease = null;
      this.event('lease_released', undefined, { leaseId, jobId: released.jobId, workloadType: released.workloadType });
      if (this.runtime.queue.length > 0) {
        this.runtime.queue = this.orderQueue(this.runtime.queue);
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
    const armed = await this.withLock(() => this.armIdleStop('tick'));
    if (!armed) return;
    if (this.stopBarrier) {
      await this.stopBarrier;
      this.stopBarrier = null;
    }
    await this.withLock(() => this.commitIdleStop());
  }

  private async tryAcquire(job: RuntimeJobRequest): Promise<AcquireOutcome> {
    this.expireStaleLease();
    const queued = this.enqueue(job);
    if (this.runtime.lease && this.runtime.lease.jobId !== job.id) {
      if (!this.canShare(this.runtime.lease, job)) {
        this.setWaitingReason(job.id, 'pod_busy');
        if (queued) {
          this.event('queued', 'RunPod busy; job waiting_runtime without starting another pod.', {
            jobId: job.id,
            workloadType: job.workloadType,
          });
          await this.persist('queued');
          this.notify();
        }
        return { lease: null };
      }
    }
    if (this.runtime.lease && this.runtime.lease.jobId === job.id) {
      return { lease: this.runtime.lease };
    }
    if (this.runtime.state === 'stopping') {
      await this.noteWaiting(job.id, 'pod_starting', 'waiting_stop', queued);
      return { lease: null };
    }
    if (this.runtime.state === 'starting' || this.runtime.state === 'warming') {
      await this.noteWaiting(
        job.id,
        this.runtime.state === 'starting' ? 'pod_starting' : 'pod_warming',
        'waiting_warm',
        queued,
      );
      return { lease: null };
    }

    const next = this.nextRunnableJob();
    if (next && next.id !== job.id) {
      await this.noteWaiting(
        job.id,
        profilesCompatible(this.runtime.profile, job.profile) ? 'pod_busy' : 'profile_change',
        'waiting_turn',
        queued,
      );
      return { lease: null };
    }

    const ready = await this.ensureReady(job.profile);
    if (ready === 'warming') {
      this.setWaitingReason(job.id, 'pod_starting');
      return { lease: null, waitForWarm: true };
    }
    if (ready === 'failed') {
      throw new Error(this.runtime.startupFailure ?? 'RunPod failed to start.');
    }
    if (ready !== 'ready') {
      return { lease: null };
    }
    const lease = this.grant(job);
    await this.persist('leased');
    return { lease };
  }

  private async ensureReady(profile: RuntimeProfileId): Promise<'ready' | 'warming' | 'wait' | 'failed'> {
    if (!this.runtime.podId && !this.options.podId) {
      this.runtime.state = 'failed';
      this.runtime.startupFailure = 'RUNPOD_POD_ID is not configured; refusing to create a pod.';
      this.runtime.lastError = this.runtime.startupFailure;
      await this.persist('missing_pod_id');
      this.event('startup_failed', this.runtime.startupFailure);
      return 'failed';
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
        return 'wait';
      }
    }

    if (active.length >= this.maxActivePods && !ours) {
      this.runtime.podId = active[0]!.id;
    } else if (active[0] && !ours) {
      this.runtime.podId = active[0].id;
    }

    if (active.length > this.maxActivePods) {
      await this.stopExtras(active);
    }

    const current = this.runtime.podId ? await this.options.client.getPod(this.runtime.podId) : active[0] ?? null;
    if (current && podIsRunning(current)) {
      this.runtime.podId = current.id;
      this.applyCost(current.costPerHr);
      if (this.runtime.state === 'idle' || this.runtime.state === 'ready' || this.runtime.state === 'stopped' || this.runtime.state === 'stopping') {
        if (this.runtime.state === 'idle' || this.runtime.state === 'stopping') {
          this.event('idle_cancelled', 'New work arrived during idle grace; shutdown cancelled.');
        }
        this.runtime.state = 'ready';
        this.runtime.idleSince = null;
        this.runtime.stoppingAt = null;
        this.runtime.stopReason = null;
      }
      if (!profilesCompatible(this.runtime.profile, profile) && RUNTIME_PROFILE_CATALOGUE[profile].requiresImageChange) {
        this.event('profile_change', `Runtime profile changing ${this.runtime.profile} → ${profile}.`);
        this.runtime.profile = profile;
      }
      this.runtime.readyAt = this.runtime.readyAt ?? this.clock.iso();
      this.runtime.state = 'ready';
      await this.persist('already_ready');
      return 'ready';
    }

    if (current && podIsActive(current) && !podIsRunning(current)) {
      this.runtime.state = 'warming';
      await this.persist('already_warming');
      this.event('warming', 'Waiting for RunPod to become ready.');
      return 'warming';
    }

    this.runtime.state = 'starting';
    this.runtime.startedAt = this.clock.iso();
    this.runtime.stoppedAt = null;
    this.runtime.stopReason = null;
    this.runtime.idleSince = null;
    this.runtime.startupFailure = null;
    await this.persist('starting');
    this.event('starting', 'Starting the shared RunPod.');
    if (!this.runtime.podId) {
      this.runtime.startupFailure = 'RUNPOD_POD_ID is not configured; refusing to create a pod.';
      this.runtime.state = 'failed';
      await this.persist('missing_pod_id');
      return 'failed';
    }
    try {
      await this.options.client.startPod(this.runtime.podId);
    } catch (err) {
      this.runtime.state = 'failed';
      this.runtime.startupFailure = sanitizeText(err instanceof Error ? err.message : String(err));
      this.runtime.lastError = this.runtime.startupFailure;
      await this.persist('startup_failed');
      this.event('startup_failed', this.runtime.startupFailure);
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.runtime.state = 'warming';
    await this.persist('warming');
    this.event('warming', 'Waiting for RunPod to become ready.');
    this.notify();
    return 'warming';
  }

  private async waitUntilRunning(signal?: AbortSignal): Promise<boolean> {
    const deadline = this.clock.now() + this.warmTimeoutMs;
    while (this.clock.now() < deadline) {
      if (signal?.aborted) throw new Error('Execution aborted.');
      if (!this.runtime.podId) return false;
      const pod = await this.options.client.getPod(this.runtime.podId);
      if (pod && podIsRunning(pod)) {
        this.applyCost(pod.costPerHr);
        return true;
      }
      await this.clock.sleep(this.pollIntervalMs, signal);
    }
    return false;
  }

  private async markStartupTimeout(): Promise<void> {
    this.runtime.state = 'failed';
    this.runtime.startupFailure = 'Timed out waiting for RunPod to become ready.';
    this.runtime.lastError = this.runtime.startupFailure;
    await this.persist('startup_timeout');
    this.event('startup_failed', this.runtime.startupFailure);
    this.notify();
  }

  private grant(job: RuntimeJobRequest): RunPodLease {
    const now = this.clock.now();
    const exclusive = this.isExclusive(job.profile);
    const lease: RunPodLease = {
      id: `lease_${randomUUID()}`,
      jobId: job.id,
      workloadType: job.workloadType ?? 'inference',
      profile: job.profile,
      requestedModel: job.requestedModel ?? null,
      acquiredAt: this.clock.iso(now),
      expiresAt: this.clock.iso(now + this.leaseTtlMs),
      heartbeatAt: this.clock.iso(now),
      state: 'acquired',
      traceId: job.traceId ?? job.id,
      exclusive,
      releasedAt: null,
    };
    this.runtime.lease = lease;
    this.runtime.profile = job.profile;
    this.runtime.state = 'busy';
    this.runtime.queue = this.runtime.queue.filter((item) => item.id !== job.id);
    this.runtime.idleSince = null;
    this.event('leased', 'Job leased the shared RunPod.', {
      jobId: job.id,
      leaseId: lease.id,
      workloadType: lease.workloadType,
    });
    this.notify();
    return lease;
  }

  private enqueue(job: RuntimeJobRequest): boolean {
    if (this.runtime.lease?.jobId === job.id) return false;
    if (this.runtime.queue.some((item) => item.id === job.id)) return false;
    const waitingReason: WaitingReason =
      this.runtime.state === 'starting'
        ? 'pod_starting'
        : this.runtime.state === 'warming'
          ? 'pod_warming'
          : this.runtime.lease
            ? 'pod_busy'
            : 'pod_starting';
    this.runtime.queue.push({
      id: job.id,
      profile: job.profile,
      workloadType: job.workloadType ?? 'inference',
      requestedModel: job.requestedModel ?? null,
      traceId: job.traceId ?? job.id,
      enqueuedAt: this.clock.iso(),
      status: 'waiting_runtime',
      waitingReason,
    });
    return true;
  }

  private setWaitingReason(jobId: string, reason: WaitingReason): boolean {
    let changed = false;
    this.runtime.queue = this.runtime.queue.map((item) => {
      if (item.id !== jobId || item.waitingReason === reason) return item;
      changed = true;
      return { ...item, waitingReason: reason };
    });
    return changed;
  }

  /**
   * Persist waiting-runtime only when the queue membership or reason actually
   * changes. Repeating the same wait must not write a tight disk/event loop.
   */
  private async noteWaiting(
    jobId: string,
    reason: WaitingReason,
    persistReason: string,
    firstEnqueue: boolean,
  ): Promise<void> {
    const changed = this.setWaitingReason(jobId, reason);
    if (!firstEnqueue && !changed) return;
    await this.persist(persistReason);
    this.notify();
  }

  private orderQueue(queue: QueuedRuntimeJob[]): QueuedRuntimeJob[] {
    const compatible: QueuedRuntimeJob[] = [];
    const rest: QueuedRuntimeJob[] = [];
    for (const item of queue) {
      if (profilesCompatible(this.runtime.profile, item.profile)) compatible.push(item);
      else rest.push(item);
    }
    return [...compatible, ...rest];
  }

  private nextRunnableJob(): QueuedRuntimeJob | null {
    return this.orderQueue(this.runtime.queue)[0] ?? null;
  }

  private isExclusive(profile: RuntimeProfileId): boolean {
    return RUNTIME_PROFILE_CATALOGUE[profile].allowsSharedConcurrency !== true;
  }

  private canShare(_lease: RunPodLease, _job: RuntimeJobRequest): boolean {
    return false;
  }

  private expireStaleLease(): void {
    if (!this.runtime.lease || this.runtime.lease.state !== 'acquired') return;
    if (Date.parse(this.runtime.lease.expiresAt) > this.clock.now()) return;
    this.event('lease_expired', 'Lease heartbeat expired; releasing exclusive hold.', {
      leaseId: this.runtime.lease.id,
      jobId: this.runtime.lease.jobId,
    });
    this.runtime.lease = { ...this.runtime.lease, state: 'expired', releasedAt: this.clock.iso() };
    this.runtime.lease = null;
    if (this.runtime.queue.length === 0) {
      this.runtime.state = 'idle';
      this.runtime.idleSince = this.clock.iso();
    } else {
      this.runtime.state = 'ready';
    }
  }

  private hasRunnableQueuedWork(): boolean {
    return this.runtime.queue.length > 0;
  }

  private hasActiveWork(): boolean {
    return this.runtime.activity === 'model_download' || this.runtime.activity === 'checkpoint';
  }

  private keepWarmActive(): boolean {
    if (!this.runtime.keepWarmUntil) return false;
    return Date.parse(this.runtime.keepWarmUntil) > this.clock.now();
  }

  private canConsiderIdleStop(): boolean {
    if (this.runtime.lease) return false;
    if (this.hasRunnableQueuedWork()) return false;
    if (this.hasActiveWork()) return false;
    if (this.keepWarmActive()) return false;
    return this.runtime.state === 'idle' || this.runtime.state === 'ready' || this.runtime.state === 'stopping';
  }

  private async armIdleStop(reason: string): Promise<boolean> {
    if (!this.canConsiderIdleStop()) return false;
    if (this.runtime.state !== 'idle' && this.runtime.state !== 'ready') return this.runtime.state === 'stopping';
    if (!this.runtime.idleSince) {
      this.runtime.state = 'idle';
      this.runtime.idleSince = this.clock.iso();
    }
    const idleForMs = this.clock.now() - Date.parse(this.runtime.idleSince);
    if (idleForMs < this.idleShutdownSeconds * 1000) return false;
    if (!this.runtime.podId) return false;
    this.runtime.state = 'stopping';
    this.runtime.stoppingAt = this.clock.iso();
    this.runtime.stopReason = reason === 'tick' ? 'idle_timeout' : `idle_timeout:${reason}`;
    await this.persist('stopping');
    this.event('stopping', 'Idle grace elapsed; shutting down the shared RunPod.');
    this.notify();
    return true;
  }

  private async commitIdleStop(): Promise<void> {
    if (this.runtime.state !== 'stopping') return;
    if (!this.canConsiderIdleStop() || this.hasRunnableQueuedWork() || this.runtime.lease || this.hasActiveWork() || this.keepWarmActive()) {
      this.runtime.state = this.runtime.lease ? 'busy' : this.runtime.queue.length > 0 ? 'ready' : 'idle';
      this.runtime.stoppingAt = null;
      this.runtime.stopReason = null;
      this.runtime.idleSince = this.runtime.lease || this.runtime.queue.length > 0 ? null : this.runtime.idleSince;
      await this.persist('stop_cancelled');
      this.event('idle_cancelled', 'Queue recheck found work before stop; shutdown cancelled.');
      this.notify();
      return;
    }
    if (!this.runtime.podId) return;
    try {
      await this.options.client.stopPod(this.runtime.podId);
    } catch (err) {
      this.runtime.lastError = sanitizeText(err instanceof Error ? err.message : String(err));
    }
    this.runtime.state = 'stopped';
    this.runtime.stoppedAt = this.clock.iso();
    this.runtime.durationMs =
      this.runtime.startedAt != null ? this.clock.now() - Date.parse(this.runtime.startedAt) : null;
    this.runtime.idleSince = null;
    this.applyCost(this.runtime.costPerHr);
    await this.persist('stopped');
    this.event('stopped', this.runtime.stopReason ?? 'stopped');
    this.notify();
  }

  private async stopExtras(active: Array<{ id: string }>): Promise<void> {
    const keep = this.runtime.podId ?? active[0]?.id;
    for (const pod of active) {
      if (pod.id === keep) continue;
      this.event('orphan_stop', 'Stopping extra paid capacity beyond RUNPOD_MAX_ACTIVE_PODS=1.', {
        detail: pod.id,
      });
      try {
        await this.options.client.stopPod(pod.id);
      } catch (err) {
        this.runtime.lastError = sanitizeText(err instanceof Error ? err.message : String(err));
      }
    }
  }

  async refuseCreatePod(): Promise<never> {
    this.event('scale_out_refused', SCALE_OUT_DISABLED_REASON);
    throw new Error(CREATE_POD_REFUSED_REASON);
  }

  private applyCost(costPerHr?: number | null): void {
    if (typeof costPerHr === 'number') this.runtime.costPerHr = costPerHr;
    if (typeof this.runtime.costPerHr === 'number' && this.runtime.startedAt) {
      const hours = Math.max(0, this.clock.now() - Date.parse(this.runtime.startedAt)) / 3_600_000;
      this.runtime.costUsd = Number((this.runtime.costPerHr * hours).toFixed(4));
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

  private withLock<T>(fn: () => Promise<T> | T): Promise<T> {
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

export function waitingCopy(reason: WaitingReason, state: RuntimeState): string {
  if (reason === 'pod_starting' || reason === 'pod_warming' || state === 'starting' || state === 'warming') {
    return 'GPU runtime starting';
  }
  if (reason === 'profile_change') return 'Waiting for the shared GPU runtime profile.';
  return 'Waiting for the shared GPU';
}
