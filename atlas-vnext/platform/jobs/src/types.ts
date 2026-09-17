import type { JobRecord, JobStatus, StructuredFailure } from '@atlas-vnext/contracts';

export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['running', 'waiting_runtime', 'cancelled'],
  running: ['waiting', 'waiting_runtime', 'waiting_permission', 'paused', 'completed', 'failed', 'cancelled'],
  waiting: ['running', 'cancelled', 'failed'],
  waiting_runtime: ['running', 'cancelled', 'failed'],
  waiting_permission: ['running', 'cancelled', 'failed'],
  paused: ['running', 'cancelled'],
  completed: [],
  failed: ['queued'],
  cancelled: [],
};

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['completed', 'cancelled'];

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!JOB_TRANSITIONS[from].includes(to)) {
    throw new Error(`Illegal job transition ${from} → ${to}`);
  }
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

export interface JobActor {
  tenantId: string;
  workspaceId?: string | null;
  principalId?: string | null;
}

export interface JobEnqueueInput {
  projectId?: string | null;
  workspaceId?: string | null;
  dungeon: string;
  type: string;
  priority?: number;
  traceId?: string;
  idempotencyKey?: string;
  maxRetries?: number;
  checkpoint?: Record<string, unknown>;
}

export interface JobCheckpointRecord {
  id: string;
  tenantId: string;
  jobId: string;
  stage: string;
  progressRatio: number;
  data: Record<string, unknown>;
  createdAt: string;
  idempotencyKey?: string | null;
}

export type JobAttemptOutcome = 'started' | 'succeeded' | 'failed' | 'released' | 'lease_expired';

export interface JobAttemptRecord {
  id: string;
  tenantId: string;
  jobId: string;
  attemptNumber: number;
  workerId: string | null;
  outcome: JobAttemptOutcome;
  startedAt: string;
  finishedAt: string | null;
  failureReason: StructuredFailure | null;
}

export interface JobEventSink {
  publish(input: {
    channel: string;
    type: string;
    payload: unknown;
    jobId: string;
    tenantId: string;
    workspaceId?: string | null;
    idempotencyKey?: string;
  }): Promise<void>;
}

export interface JobClaimFilter {
  /** Inclusive lower bound on persisted `JobRecord.priority`. */
  minPriority?: number;
  /** When set, only these job types may be claimed. */
  types?: readonly string[];
}

export interface JobStore {
  insert(record: JobRecord): Promise<JobRecord>;
  findByIdempotency(tenantId: string, key: string): Promise<JobRecord | null>;
  get(tenantId: string, id: string): Promise<JobRecord | null>;
  save(record: JobRecord, expectedStatuses?: JobStatus[]): Promise<JobRecord>;
  claimQueued(input: {
    tenantId: string;
    workspaceId?: string | null;
    workerId: string;
    leaseUntil: string;
    now: string;
  } & JobClaimFilter): Promise<JobRecord | null>;
  listExpiredRunning(now: string): Promise<JobRecord[]>;
  listByLeaseOwner(workerId: string): Promise<JobRecord[]>;
  appendCheckpoint(row: JobCheckpointRecord): Promise<JobCheckpointRecord>;
  latestCheckpoint(tenantId: string, jobId: string): Promise<JobCheckpointRecord | null>;
  findCheckpointByIdempotency(tenantId: string, key: string): Promise<JobCheckpointRecord | null>;
  recordAttempt(row: JobAttemptRecord): Promise<JobAttemptRecord>;
  finishAttempt(
    tenantId: string,
    jobId: string,
    patch: { outcome: JobAttemptOutcome; finishedAt: string; failureReason?: StructuredFailure | null; workerId?: string | null },
  ): Promise<JobAttemptRecord | null>;
  listAttempts(tenantId: string, jobId: string): Promise<JobAttemptRecord[]>;
}

export interface UnitOfWork {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export interface DurableJobEngine {
  enqueue(actor: JobActor, input: JobEnqueueInput): Promise<JobRecord>;
  get(actor: JobActor, id: string): Promise<JobRecord | null>;
  claimNext(
    actor: JobActor,
    workerId: string,
    leaseMs: number,
    filter?: JobClaimFilter,
  ): Promise<JobRecord | null>;
  heartbeat(actor: JobActor, id: string, workerId: string, leaseMs: number): Promise<JobRecord>;
  checkpoint(
    actor: JobActor,
    id: string,
    stage: string,
    progressRatio: number,
    data: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<JobRecord>;
  complete(actor: JobActor, id: string): Promise<JobRecord>;
  fail(actor: JobActor, id: string, error: { code: string; message: string; retryable: boolean }): Promise<JobRecord>;
  cancel(actor: JobActor, id: string): Promise<JobRecord>;
  waitForRuntime(actor: JobActor, id: string): Promise<JobRecord>;
  resumeFromRuntime(actor: JobActor, id: string): Promise<JobRecord>;
  recoverExpiredLeases(now?: string): Promise<JobRecord[]>;
  releaseWorker(workerId: string): Promise<JobRecord[]>;
  recoverTerminal(actor: JobActor, id: string, to: 'queued'): Promise<JobRecord>;
  listAttempts(actor: JobActor, id: string): Promise<JobAttemptRecord[]>;
}

/** @deprecated Use DurableJobEngine. Kept so existing type imports compile. */
export interface JobEngine {
  enqueue(input: {
    projectId?: string | null;
    dungeon: string;
    type: string;
    priority?: number;
    traceId?: string;
    idempotencyKey?: string;
  }): Promise<JobRecord>;
  get(id: string): Promise<JobRecord | null>;
  checkpoint(id: string, stage: string, progressRatio: number, data: Record<string, unknown>): Promise<JobRecord>;
  complete(id: string): Promise<JobRecord>;
  fail(id: string, error: { code: string; message: string; retryable: boolean }): Promise<JobRecord>;
  cancel(id: string): Promise<JobRecord>;
}

export class JobsNotImplementedError extends Error {
  constructor() {
    super('platform/jobs is a design-gate shell; durable PostgreSQL implementation is deferred.');
    this.name = 'JobsNotImplementedError';
  }
}

export class JobOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobOwnershipError';
  }
}

export class JobLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobLeaseError';
  }
}

export class TerminalJobMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalJobMutationError';
  }
}

export function jobChannel(jobId: string): string {
  return `job:${jobId}`;
}

export function assertJobActor(actor: JobActor, action: string): void {
  if (!actor.tenantId?.trim()) {
    throw new JobOwnershipError(`Fail-closed: cannot ${action} a job without a tenant id.`);
  }
}
