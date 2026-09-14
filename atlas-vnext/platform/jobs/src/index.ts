import type { JobRecord, JobStatus } from '@atlas-vnext/contracts';

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

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!JOB_TRANSITIONS[from].includes(to)) {
    throw new Error(`Illegal job transition ${from} → ${to}`);
  }
}

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
