import { randomUUID } from 'node:crypto';
import type { JobRecord, JobStatus, StructuredFailure } from '@atlas-vnext/contracts';
import {
  assertJobActor,
  assertJobTransition,
  isTerminalJobStatus,
  JobLeaseError,
  JobOwnershipError,
  TerminalJobMutationError,
  jobChannel,
  type DurableJobEngine,
  type JobActor,
  type JobEnqueueInput,
  type JobEventSink,
  type JobStore,
  type UnitOfWork,
} from './types.ts';

export interface JobEngineOptions {
  store: JobStore;
  ids?: () => string;
  clock?: () => string;
  events?: JobEventSink;
  unitOfWork?: UnitOfWork;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

const identityUow: UnitOfWork = {
  async run<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  },
};

export function createJobEngine(options: JobEngineOptions): DurableJobEngine {
  const store = options.store;
  const ids = options.ids ?? (() => `job_${randomUUID()}`);
  const clock = options.clock ?? (() => new Date().toISOString());
  const uow = options.unitOfWork ?? identityUow;
  const log = options.log ?? (() => undefined);

  async function emit(record: JobRecord, type: string, payload: Record<string, unknown>, idempotencyKey?: string): Promise<void> {
    if (!options.events) return;
    const tenantId = record.tenantId;
    if (!tenantId) return;
    await options.events.publish({
      channel: jobChannel(record.id),
      type,
      payload: { jobId: record.id, status: record.status, ...payload },
      jobId: record.id,
      tenantId,
      workspaceId: record.workspaceId ?? record.projectId ?? null,
      idempotencyKey,
    });
  }

  async function loadOwned(actor: JobActor, id: string, action: string): Promise<JobRecord> {
    assertJobActor(actor, action);
    const record = await store.get(actor.tenantId, id);
    if (!record) {
      log('ownership.rejected', { action, tenantId: actor.tenantId, jobId: id });
      throw new JobOwnershipError(`Fail-closed: job ${id} is not visible to tenant ${actor.tenantId}.`);
    }
    if (actor.workspaceId && record.workspaceId && actor.workspaceId !== record.workspaceId) {
      log('ownership.rejected', { action, tenantId: actor.tenantId, workspaceId: actor.workspaceId, jobId: id });
      throw new JobOwnershipError(`Fail-closed: job ${id} is not visible to workspace ${actor.workspaceId}.`);
    }
    return record;
  }

  function transition(record: JobRecord, to: JobStatus, patch: Partial<JobRecord> = {}): JobRecord {
    if (record.status !== to) {
      if (isTerminalJobStatus(record.status) && to !== record.status) {
        throw new TerminalJobMutationError(`Job ${record.id} is ${record.status} and cannot move to ${to}.`);
      }
      assertJobTransition(record.status, to);
    }
    const now = clock();
    const terminal = to === 'completed' || to === 'failed' || to === 'cancelled';
    return {
      ...record,
      ...patch,
      status: to,
      updatedAt: now,
      startedAt: to === 'running' ? (record.startedAt ?? now) : (patch.startedAt ?? record.startedAt),
      completedAt: terminal ? (patch.completedAt ?? now) : (patch.completedAt ?? record.completedAt),
      leaseOwner: terminal ? null : (patch.leaseOwner ?? record.leaseOwner),
      leaseUntil: terminal ? null : (patch.leaseUntil ?? record.leaseUntil),
    };
  }

  return {
    async enqueue(actor, input) {
      assertJobActor(actor, 'enqueue');
      return uow.run(async () => {
        if (input.idempotencyKey) {
          const existing = await store.findByIdempotency(actor.tenantId, input.idempotencyKey);
          if (existing) return existing;
        }
        const now = clock();
        const id = ids();
        const record: JobRecord = {
          id,
          tenantId: actor.tenantId,
          workspaceId: input.workspaceId ?? actor.workspaceId ?? input.projectId ?? null,
          projectId: input.projectId ?? actor.workspaceId ?? null,
          dungeon: input.dungeon,
          type: input.type,
          status: 'queued',
          priority: input.priority ?? 0,
          currentStage: null,
          progressRatio: 0,
          checkpoint: input.checkpoint ?? {},
          retryCount: 0,
          maxRetries: input.maxRetries ?? 3,
          leaseOwner: null,
          leaseUntil: null,
          idempotencyKey: input.idempotencyKey ?? null,
          cancelRequested: false,
          traceId: input.traceId ?? id,
          failureReason: null,
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          completedAt: null,
        };
        const saved = await store.insert(record);
        await emit(saved, 'job.created', { dungeon: saved.dungeon, type: saved.type }, input.idempotencyKey ? `job:${input.idempotencyKey}:created` : undefined);
        log('job.enqueued', { jobId: saved.id, tenantId: actor.tenantId, type: saved.type });
        return saved;
      });
    },

    async get(actor, id) {
      assertJobActor(actor, 'get');
      const record = await store.get(actor.tenantId, id);
      if (!record) return null;
      if (actor.workspaceId && record.workspaceId && actor.workspaceId !== record.workspaceId) return null;
      return record;
    },

    async claimNext(actor, workerId, leaseMs) {
      assertJobActor(actor, 'claim');
      const now = clock();
      const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
      return uow.run(async () => {
        const claimed = await store.claimQueued({
          tenantId: actor.tenantId,
          workspaceId: actor.workspaceId ?? null,
          workerId,
          leaseUntil,
          now,
        });
        if (!claimed) return null;
        await emit(claimed, 'job.started', { workerId });
        log('job.claimed', { jobId: claimed.id, tenantId: actor.tenantId, workerId, leaseUntil });
        return claimed;
      });
    },

    async heartbeat(actor, id, workerId, leaseMs) {
      return uow.run(async () => {
        const record = await loadOwned(actor, id, 'heartbeat');
        if (record.leaseOwner !== workerId) {
          throw new JobLeaseError(`Worker ${workerId} does not hold the lease for job ${id}.`);
        }
        if (record.status !== 'running') {
          throw new JobLeaseError(`Job ${id} is ${record.status}, not running.`);
        }
        const now = clock();
        const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
        return store.save({ ...record, leaseUntil, updatedAt: now, leaseOwner: workerId }, ['running']);
      });
    },

    async checkpoint(actor, id, stage, progressRatio, data) {
      return uow.run(async () => {
        const record = await loadOwned(actor, id, 'checkpoint');
        if (isTerminalJobStatus(record.status)) {
          throw new TerminalJobMutationError(`Job ${id} is ${record.status} and cannot checkpoint.`);
        }
        const now = clock();
        const next: JobRecord = {
          ...record,
          currentStage: stage,
          progressRatio,
          checkpoint: data,
          updatedAt: now,
        };
        const saved = await store.save(next);
        await store.appendCheckpoint({
          id: `jcp_${randomUUID()}`,
          tenantId: actor.tenantId,
          jobId: id,
          stage,
          progressRatio,
          data,
          createdAt: now,
        });
        await emit(saved, 'job.checkpoint', { stage, progressRatio });
        return saved;
      });
    },

    async complete(actor, id) {
      return uow.run(async () => {
        const record = await loadOwned(actor, id, 'complete');
        const saved = await store.save(transition(record, 'completed', { progressRatio: 1 }));
        await emit(saved, 'job.completed', {});
        return saved;
      });
    },

    async fail(actor, id, error) {
      return uow.run(async () => {
        const record = await loadOwned(actor, id, 'fail');
        const failure: StructuredFailure = { ...error, at: clock() };
        const saved = await store.save(transition(record, 'failed', { failureReason: failure }));
        await emit(saved, 'job.failed', { code: error.code });
        return saved;
      });
    },

    async cancel(actor, id) {
      return uow.run(async () => {
        const record = await loadOwned(actor, id, 'cancel');
        if (record.status === 'cancelled') return record;
        if (record.status === 'completed') return record;
        const saved = await store.save(
          transition(record, 'cancelled', {
            cancelRequested: true,
            failureReason: { code: 'cancelled', message: 'Job cancelled.', retryable: false, at: clock() },
          }),
        );
        await emit(saved, 'job.cancelled', {});
        log('job.cancelled', { jobId: id, tenantId: actor.tenantId });
        return saved;
      });
    },

    async waitForRuntime(actor, id) {
      return uow.run(async () => {
        const record = await loadOwned(actor, id, 'waitForRuntime');
        const saved = await store.save(transition(record, 'waiting_runtime', { leaseOwner: null, leaseUntil: null }));
        await emit(saved, 'job.waiting_runtime', {});
        return saved;
      });
    },

    async resumeFromRuntime(actor, id) {
      return uow.run(async () => {
        const record = await loadOwned(actor, id, 'resumeFromRuntime');
        const saved = await store.save(transition(record, 'running'));
        await emit(saved, 'job.started', { resumed: true });
        return saved;
      });
    },

    async recoverExpiredLeases(nowStamp) {
      const now = nowStamp ?? clock();
      return uow.run(async () => {
        const expired = await store.listExpiredRunning(now);
        const recovered: JobRecord[] = [];
        for (const record of expired) {
          if (record.status === 'waiting_runtime') continue;
          log('lease.expired', { jobId: record.id, tenantId: record.tenantId, leaseOwner: record.leaseOwner });
          if (record.retryCount < record.maxRetries) {
            const failed = transition(record, 'failed', {
              retryCount: record.retryCount + 1,
              leaseOwner: null,
              leaseUntil: null,
              failureReason: {
                code: 'lease_expired',
                message: 'Worker lease expired; job re-queued from checkpoint.',
                retryable: true,
                at: now,
              },
            });
            const next = transition(failed, 'queued', {
              leaseOwner: null,
              leaseUntil: null,
              startedAt: null,
              completedAt: null,
            });
            const saved = await store.save(next);
            await emit(saved, 'job.retry_scheduled', { retryCount: saved.retryCount });
            log('retry.scheduled', { jobId: saved.id, retryCount: saved.retryCount });
            log('job.recovered', { jobId: saved.id, status: saved.status });
            recovered.push(saved);
          } else {
            const next = transition(record, 'failed', {
              leaseOwner: null,
              leaseUntil: null,
              failureReason: {
                code: 'lease_expired',
                message: 'Worker lease expired and retries are exhausted.',
                retryable: false,
                at: now,
              },
            });
            const saved = await store.save(next);
            await emit(saved, 'job.failed', { code: 'lease_expired' });
            log('job.recovered', { jobId: saved.id, status: saved.status });
            recovered.push(saved);
          }
        }
        return recovered;
      });
    },

    async releaseWorker(workerId) {
      return uow.run(async () => {
        const owned = await store.listByLeaseOwner(workerId);
        const released: JobRecord[] = [];
        for (const record of owned) {
          if (record.status !== 'running') continue;
          const failed = transition(record, 'failed', {
            leaseOwner: null,
            leaseUntil: null,
            failureReason: {
              code: 'worker_released',
              message: 'Worker shut down and released the lease.',
              retryable: true,
              at: clock(),
            },
          });
          const next = transition(failed, 'queued', {
            leaseOwner: null,
            leaseUntil: null,
            completedAt: null,
          });
          const saved = await store.save(next);
          await emit(saved, 'job.released', { workerId });
          log('job.released', { jobId: saved.id, workerId });
          released.push(saved);
        }
        return released;
      });
    },

    async recoverTerminal(actor, id, to) {
      return uow.run(async () => {
        const record = await loadOwned(actor, id, 'recover');
        if (record.status !== 'failed' && record.status !== 'cancelled') {
          throw new TerminalJobMutationError(`Admin recovery only applies to failed/cancelled jobs; ${id} is ${record.status}.`);
        }
        if (to !== 'queued') {
          throw new TerminalJobMutationError(`Admin recovery target ${to} is not allowed.`);
        }
        if (record.status === 'cancelled') {
          // explicit admin exception to terminal immutability
          const now = clock();
          const saved = await store.save({
            ...record,
            status: 'queued',
            cancelRequested: false,
            leaseOwner: null,
            leaseUntil: null,
            completedAt: null,
            failureReason: null,
            updatedAt: now,
          });
          await emit(saved, 'job.requeued', { admin: true });
          return saved;
        }
        const saved = await store.save(transition(record, 'queued', { leaseOwner: null, leaseUntil: null, completedAt: null }));
        await emit(saved, 'job.requeued', { admin: true });
        return saved;
      });
    },
  };
}

export type { JobEnqueueInput };
