import { randomUUID } from 'node:crypto';
import type {
  DurableJob,
  IContentAddressedStorage,
  IExecutionBroker,
  IProgressBroadcaster,
  JobExecutionTask,
  JobProgressEvent,
  JobStage,
  JobStatus,
} from '@atlas/core-contracts';

export class InMemoryProgressBroadcaster implements IProgressBroadcaster {
  readonly #listeners = new Map<string, Set<(event: JobProgressEvent) => void>>();

  subscribe(channel: string, listener: (event: JobProgressEvent) => void): () => void {
    if (!this.#listeners.has(channel)) {
      this.#listeners.set(channel, new Set());
    }
    this.#listeners.get(channel)!.add(listener);

    return () => {
      this.#listeners.get(channel)?.delete(listener);
    };
  }

  publish(event: JobProgressEvent): void {
    const directListeners = this.#listeners.get(event.jobId);
    if (directListeners) {
      for (const listener of directListeners) {
        try {
          listener(event);
        } catch {
          // Keep broadcaster stable against listener failures
        }
      }
    }
    const globalListeners = this.#listeners.get('*');
    if (globalListeners) {
      for (const listener of globalListeners) {
        try {
          listener(event);
        } catch {}
      }
    }
  }
}

export class InMemoryExecutionBroker implements IExecutionBroker {
  readonly #jobs = new Map<string, DurableJob>();
  readonly #storage: IContentAddressedStorage;
  readonly #broadcaster: IProgressBroadcaster;

  constructor(storage: IContentAddressedStorage, broadcaster: IProgressBroadcaster) {
    this.#storage = storage;
    this.#broadcaster = broadcaster;
  }

  async submitJob(task: JobExecutionTask): Promise<DurableJob> {
    const now = new Date().toISOString();
    const inputDesc = await this.#storage.put(
      JSON.stringify(task.input),
      'application/json',
      { jobId: task.jobId, type: task.type },
    );

    const initialStage: JobStage = {
      id: 'init',
      label: 'Job Initialized',
      status: 'queued',
      progressPercent: 0,
    };

    const job: DurableJob = {
      id: task.jobId || randomUUID(),
      userId: task.context.user?.id || 'anonymous',
      type: task.type,
      status: 'queued',
      currentStage: initialStage.id,
      stages: [initialStage],
      inputHash: inputDesc.hash,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.#jobs.set(job.id, job);

    this.#broadcaster.publish({
      jobId: job.id,
      stageId: initialStage.id,
      progressPercent: 0,
      status: 'queued',
      message: 'Job submitted and queued for execution',
      timestamp: now,
    });

    return job;
  }

  async getJob(jobId: string): Promise<DurableJob | null> {
    return this.#jobs.get(jobId) || null;
  }

  async cancelJob(jobId: string, _actorId: string): Promise<boolean> {
    const job = this.#jobs.get(jobId);
    if (!job || job.status === 'completed' || job.status === 'failed') {
      return false;
    }

    const now = new Date().toISOString();
    const updated: DurableJob = {
      ...job,
      status: 'cancelled',
      updatedAt: now,
    };
    this.#jobs.set(job.id, updated);

    this.#broadcaster.publish({
      jobId: job.id,
      stageId: job.currentStage || 'cancel',
      progressPercent: 0,
      status: 'cancelled',
      message: 'Job cancelled by actor',
      timestamp: now,
    });

    return true;
  }

  async claimLease(workerId: string, maxBatchSize = 1): Promise<readonly DurableJob[]> {
    const claimed: DurableJob[] = [];
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseUntilIso = new Date(now.getTime() + 30_000).toISOString();

    for (const [id, job] of this.#jobs.entries()) {
      if (claimed.length >= maxBatchSize) break;

      const isClaimable =
        job.status === 'queued' ||
        (job.status === 'running' && job.leaseUntil && new Date(job.leaseUntil) < now);

      if (isClaimable) {
        const updated: DurableJob = {
          ...job,
          status: 'running',
          leaseOwner: workerId,
          leaseUntil: leaseUntilIso,
          updatedAt: nowIso,
        };
        this.#jobs.set(id, updated);
        claimed.push(updated);

        this.#broadcaster.publish({
          jobId: job.id,
          stageId: job.currentStage || 'lease',
          progressPercent: 10,
          status: 'running',
          message: `Lease acquired by worker ${workerId}`,
          timestamp: nowIso,
        });
      }
    }

    return claimed;
  }

  async renewLease(jobId: string, workerId: string, leaseDurationMs = 30_000): Promise<boolean> {
    const job = this.#jobs.get(jobId);
    if (!job || job.leaseOwner !== workerId || job.status !== 'running') {
      return false;
    }

    const now = new Date();
    const updated: DurableJob = {
      ...job,
      leaseUntil: new Date(now.getTime() + leaseDurationMs).toISOString(),
      updatedAt: now.toISOString(),
    };
    this.#jobs.set(job.id, updated);
    return true;
  }

  async releaseLease(jobId: string, workerId: string): Promise<void> {
    const job = this.#jobs.get(jobId);
    if (job && job.leaseOwner === workerId) {
      const updated: DurableJob = {
        ...job,
        leaseOwner: undefined,
        leaseUntil: undefined,
        updatedAt: new Date().toISOString(),
      };
      this.#jobs.set(job.id, updated);
    }
  }

  async updateJobProgress(
    jobId: string,
    stageId: string,
    percent: number,
    status: JobStatus,
    message?: string,
  ): Promise<void> {
    const job = this.#jobs.get(jobId);
    if (!job) return;

    const now = new Date().toISOString();
    const updated: DurableJob = {
      ...job,
      status,
      currentStage: stageId,
      updatedAt: now,
    };
    this.#jobs.set(job.id, updated);

    this.#broadcaster.publish({
      jobId: job.id,
      stageId,
      progressPercent: percent,
      status,
      message,
      timestamp: now,
    });
  }
}
