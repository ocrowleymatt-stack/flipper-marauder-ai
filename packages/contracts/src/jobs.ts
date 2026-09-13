import { z } from 'zod';
import { DottedName, IsoTimestamp, NonEmptyString, SchemaVersion } from './common.js';
import { atlasId } from './ids.js';

export const JOB_STATUSES = ['queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled'] as const;
export const JobStatus = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatus>;

export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled']);

export const JobProgress = z.object({
  percent: z.number().min(0).max(100).optional(),
  message: z.string().optional(),
  stage: z.string().optional(),
});
export type JobProgress = z.infer<typeof JobProgress>;

export const JobCheckpoint = z.object({
  sequence: z.number().int().min(0),
  stage: NonEmptyString,
  createdAt: IsoTimestamp,
  state: z.unknown().optional(),
});
export type JobCheckpoint = z.infer<typeof JobCheckpoint>;

export const JobRetry = z
  .object({
    attempt: z.number().int().min(0),
    maxAttempts: z.number().int().min(1),
    nextRetryAt: IsoTimestamp.optional(),
  })
  .refine((retry) => retry.attempt <= retry.maxAttempts, {
    path: ['attempt'],
    message: 'attempt cannot exceed maxAttempts',
  });
export type JobRetry = z.infer<typeof JobRetry>;

export const JobCancellation = z
  .object({
    requested: z.boolean(),
    requestedAt: IsoTimestamp.optional(),
    reason: z.string().optional(),
  })
  .refine((c) => c.requested || (c.requestedAt === undefined && c.reason === undefined), {
    message: 'requestedAt/reason are only valid when cancellation was requested',
  });
export type JobCancellation = z.infer<typeof JobCancellation>;

export const JOB_FAILURE_CLASSES = [
  'transient',
  'permanent',
  'cancelled',
  'timeout',
  'permission',
  'validation',
] as const;
export const JobFailureClass = z.enum(JOB_FAILURE_CLASSES);
export type JobFailureClass = z.infer<typeof JobFailureClass>;

export const JobFailure = z.object({
  class: JobFailureClass,
  message: NonEmptyString,
  cause: z.unknown().optional(),
});
export type JobFailure = z.infer<typeof JobFailure>;

export const JobRecord = z
  .object({
    schemaVersion: SchemaVersion,
    id: atlasId('job'),
    kind: DottedName,
    status: JobStatus,
    projectId: atlasId('prj').optional(),
    progress: JobProgress,
    checkpoints: z.array(JobCheckpoint),
    retry: JobRetry,
    cancellation: JobCancellation,
    resumable: z.boolean(),
    createdAt: IsoTimestamp,
    startedAt: IsoTimestamp.optional(),
    updatedAt: IsoTimestamp,
    finishedAt: IsoTimestamp.optional(),
    failure: JobFailure.optional(),
    traceId: atlasId('trace'),
  })
  .superRefine((job, ctx) => {
    const terminal = TERMINAL_JOB_STATUSES.has(job.status);
    if (terminal && job.finishedAt === undefined) {
      ctx.addIssue({ code: 'custom', path: ['finishedAt'], message: `finishedAt is required when status is ${job.status}` });
    }
    if (!terminal && job.finishedAt !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['finishedAt'], message: `finishedAt is not allowed when status is ${job.status}` });
    }
    if (job.status === 'failed' && job.failure === undefined) {
      ctx.addIssue({ code: 'custom', path: ['failure'], message: 'failure is required when status is failed' });
    }
    if (job.status === 'succeeded' && job.failure !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['failure'], message: 'failure is not allowed when status is succeeded' });
    }
    if (job.status !== 'queued' && job.status !== 'cancelled' && job.startedAt === undefined) {
      ctx.addIssue({ code: 'custom', path: ['startedAt'], message: `startedAt is required when status is ${job.status}` });
    }
    const sequences = job.checkpoints.map((c) => c.sequence);
    if (new Set(sequences).size !== sequences.length) {
      ctx.addIssue({ code: 'custom', path: ['checkpoints'], message: 'checkpoint sequences must be unique' });
    }
  });
export type JobRecord = z.infer<typeof JobRecord>;
