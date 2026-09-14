import type { JobRecord, JobStatus, StructuredFailure } from '@atlas-vnext/contracts';
import type { JobAttemptRecord, JobCheckpointRecord, JobStore } from './types.ts';

class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export class MemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly checkpoints: JobCheckpointRecord[] = [];
  private readonly attempts: JobAttemptRecord[] = [];
  private readonly mutex = new AsyncMutex();

  async insert(record: JobRecord): Promise<JobRecord> {
    return this.mutex.run(async () => {
      if (this.jobs.has(record.id)) {
        throw new Error(`Job ${record.id} already exists.`);
      }
      const copy = clone(record);
      this.jobs.set(record.id, copy);
      return clone(copy);
    });
  }

  async findByIdempotency(tenantId: string, key: string): Promise<JobRecord | null> {
    for (const job of this.jobs.values()) {
      if (job.tenantId === tenantId && job.idempotencyKey === key) return clone(job);
    }
    return null;
  }

  async get(tenantId: string, id: string): Promise<JobRecord | null> {
    const job = this.jobs.get(id);
    if (!job || job.tenantId !== tenantId) return null;
    return clone(job);
  }

  async save(record: JobRecord, expectedStatuses?: JobStatus[]): Promise<JobRecord> {
    return this.mutex.run(async () => {
      const existing = this.jobs.get(record.id);
      if (!existing) throw new Error(`Job ${record.id} not found.`);
      if (existing.tenantId && record.tenantId && existing.tenantId !== record.tenantId) {
        throw new Error(`Job ${record.id} tenant mismatch.`);
      }
      if (expectedStatuses && !expectedStatuses.includes(existing.status)) {
        throw new Error(`Job ${record.id} is ${existing.status}, expected ${expectedStatuses.join('|')}.`);
      }
      const copy = clone(record);
      this.jobs.set(record.id, copy);
      return clone(copy);
    });
  }

  async claimQueued(input: {
    tenantId: string;
    workspaceId?: string | null;
    workerId: string;
    leaseUntil: string;
    now: string;
  }): Promise<JobRecord | null> {
    return this.mutex.run(async () => {
      const candidates = [...this.jobs.values()]
        .filter((job) => job.tenantId === input.tenantId)
        .filter((job) => !input.workspaceId || job.workspaceId === input.workspaceId)
        .filter((job) => job.status === 'queued' && !job.cancelRequested)
        .filter((job) => !job.leaseUntil || job.leaseUntil <= input.now)
        .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
      const picked = candidates[0];
      if (!picked) return null;
      picked.status = 'running';
      picked.leaseOwner = input.workerId;
      picked.leaseUntil = input.leaseUntil;
      picked.startedAt = picked.startedAt ?? input.now;
      picked.updatedAt = input.now;
      return clone(picked);
    });
  }

  async listExpiredRunning(now: string): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => job.status === 'running' && job.leaseUntil !== null && job.leaseUntil <= now)
      .map(clone);
  }

  async listByLeaseOwner(workerId: string): Promise<JobRecord[]> {
    return [...this.jobs.values()].filter((job) => job.leaseOwner === workerId).map(clone);
  }

  async appendCheckpoint(row: JobCheckpointRecord): Promise<JobCheckpointRecord> {
    if (row.idempotencyKey) {
      const existing = await this.findCheckpointByIdempotency(row.tenantId, row.idempotencyKey);
      if (existing) return existing;
    }
    const copy = clone(row);
    this.checkpoints.push(copy);
    return clone(copy);
  }

  async latestCheckpoint(tenantId: string, jobId: string): Promise<JobCheckpointRecord | null> {
    const matches = this.checkpoints.filter((row) => row.tenantId === tenantId && row.jobId === jobId);
    return matches.length ? clone(matches[matches.length - 1]!) : null;
  }

  async findCheckpointByIdempotency(tenantId: string, key: string): Promise<JobCheckpointRecord | null> {
    const found = this.checkpoints.find((row) => row.tenantId === tenantId && row.idempotencyKey === key);
    return found ? clone(found) : null;
  }

  async recordAttempt(row: JobAttemptRecord): Promise<JobAttemptRecord> {
    const copy = clone(row);
    this.attempts.push(copy);
    return clone(copy);
  }

  async finishAttempt(
    tenantId: string,
    jobId: string,
    patch: {
      outcome: JobAttemptRecord['outcome'];
      finishedAt: string;
      failureReason?: StructuredFailure | null;
      workerId?: string | null;
    },
  ): Promise<JobAttemptRecord | null> {
    const open = [...this.attempts]
      .reverse()
      .find((row) => row.tenantId === tenantId && row.jobId === jobId && row.finishedAt === null);
    if (!open) return null;
    open.outcome = patch.outcome;
    open.finishedAt = patch.finishedAt;
    open.failureReason = patch.failureReason ?? null;
    if (patch.workerId !== undefined) open.workerId = patch.workerId;
    return clone(open);
  }

  async listAttempts(tenantId: string, jobId: string): Promise<JobAttemptRecord[]> {
    return this.attempts.filter((row) => row.tenantId === tenantId && row.jobId === jobId).map(clone);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
