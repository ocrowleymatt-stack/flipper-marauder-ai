import { z } from 'zod';
import { Identifier, IsoTimestamp, Metadata, NonEmptyString, Uuid } from './primitives.js';
import { ContractVersion } from './version.js';

export const JOB_STATES = [
  'queued',
  'leased',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export const JobState = z.enum(JOB_STATES);

export const TERMINAL_JOB_STATES = ['succeeded', 'failed', 'cancelled'] as const;

export function isTerminalJobState(state: JobState): boolean {
  return (TERMINAL_JOB_STATES as readonly string[]).includes(state);
}

export const JobError = z
  .strictObject({
    code: Identifier,
    message: NonEmptyString.max(2000),
    retryable: z.boolean(),
    details: Metadata.optional(),
  })
  .describe('A failure, classified by whether trying again could plausibly help.');

export const BACKOFF_STRATEGIES = ['fixed', 'exponential'] as const;

export const RetryPolicy = z
  .strictObject({
    maxAttempts: z.number().int().min(1).max(100),
    strategy: z.enum(BACKOFF_STRATEGIES),
    initialDelayMs: z.number().int().nonnegative(),
    maxDelayMs: z.number().int().nonnegative(),
    jitter: z.boolean(),
  })
  .describe('How many times and how quickly a failed job may be retried.');

export const JobLease = z
  .strictObject({
    leaseId: Uuid,
    holder: NonEmptyString.max(128).describe('Worker identity that currently owns the job.'),
    acquiredAt: IsoTimestamp,
    expiresAt: IsoTimestamp.describe(
      'After this instant the lease is void and the job may be reclaimed, whether or not the holder noticed.',
    ),
  })
  .describe('A time-bounded, exclusive claim on a job.');

export const JobAttempt = z
  .strictObject({
    number: z.number().int().min(1),
    startedAt: IsoTimestamp,
    endedAt: IsoTimestamp.optional(),
    holder: NonEmptyString.max(128),
    outcome: z.enum(['succeeded', 'failed', 'cancelled', 'lease-expired']).optional(),
    error: JobError.optional(),
  })
  .describe('The record of one execution attempt. Attempts are append-only.');

export const JOB_STEP_STATES = ['pending', 'running', 'succeeded', 'failed', 'skipped'] as const;

export const JobStep = z
  .strictObject({
    id: Uuid,
    name: Identifier,
    state: z.enum(JOB_STEP_STATES),
    moduleId: Identifier.optional().describe('Which module executes this step, if any.'),
    startedAt: IsoTimestamp.optional(),
    endedAt: IsoTimestamp.optional(),
  })
  .describe('One unit of work inside a job. The broker drives steps in declared order.');

export const JobEnvelope = z
  .strictObject({
    id: Uuid,
    contractVersion: ContractVersion,
    type: Identifier.describe('Job type, usually mirroring the command type that created it.'),
    projectId: Uuid,
    commandId: Uuid,
    idempotencyKey: NonEmptyString.max(200),
    state: JobState,
    priority: z.number().int().min(0).max(9).describe('0 is most urgent.'),
    createdAt: IsoTimestamp,
    updatedAt: IsoTimestamp,
    availableAt: IsoTimestamp.describe('Earliest instant the job may be leased; drives backoff.'),
    attempt: z.number().int().nonnegative().describe('Attempts started so far.'),
    retryPolicy: RetryPolicy,
    timeoutMs: z.number().int().positive().describe('Wall-clock budget for a single attempt.'),
    lease: JobLease.nullable(),
    cancellationRequested: z.boolean(),
    steps: z.array(JobStep),
    attempts: z.array(JobAttempt),
    lastError: JobError.nullable(),
    payload: z.unknown(),
    metadata: Metadata.optional(),
  })
  .describe('The durable unit of work. Everything Atlas does is a job in this shape.');

export const JobClaimRequest = z
  .strictObject({
    holder: NonEmptyString.max(128),
    leaseDurationMs: z.number().int().positive(),
    jobTypes: z.array(Identifier).optional().describe('Absent means "any type".'),
    limit: z.number().int().min(1).max(100),
  })
  .describe('A worker asking the store for work it may exclusively own for a while.');

export type JobState = z.infer<typeof JobState>;
export type JobError = z.infer<typeof JobError>;
export type RetryPolicy = z.infer<typeof RetryPolicy>;
export type JobLease = z.infer<typeof JobLease>;
export type JobAttempt = z.infer<typeof JobAttempt>;
export type JobStep = z.infer<typeof JobStep>;
export type JobEnvelope = z.infer<typeof JobEnvelope>;
export type JobClaimRequest = z.infer<typeof JobClaimRequest>;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  strategy: 'exponential',
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitter: true,
};
