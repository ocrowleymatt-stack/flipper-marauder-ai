import { z } from 'zod';

import { objectIdSchema } from './ids.js';

export const jobStatusSchema = z.enum([
  'queued',
  'running',
  'blocked',
  'completed',
  'cancelled',
  'failed',
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const failureClassificationSchema = z.enum([
  'timeout',
  'unavailable',
  'auth_failure',
  'invalid_request',
  'context_length',
  'malformed_response',
  'abrupt_end',
  'cancelled',
  'unknown',
]);
export type FailureClassification = z.infer<typeof failureClassificationSchema>;

export const jobFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  classifiedAs: failureClassificationSchema,
});
export type JobFailure = z.infer<typeof jobFailureSchema>;

export const jobSchema = z.object({
  schemaVersion: z.literal(1),
  id: objectIdSchema,
  projectId: objectIdSchema,
  type: z.string().min(1),
  status: jobStatusSchema,
  progress: z.object({
    ratio: z.number().min(0).max(1),
    message: z.string().optional(),
    phase: z.string().optional(),
  }),
  checkpoint: z.record(z.unknown()),
  retry: z.object({
    attempt: z.number().int().min(0),
    nextAttemptAt: z.string().datetime().optional(),
    reason: z.string().optional(),
  }),
  cancellation: z.object({
    requestedAt: z.string().datetime().optional(),
    reason: z.string().optional(),
  }),
  failure: jobFailureSchema.optional(),
  lease: z
    .object({
      workerId: z.string().min(1),
      expiresAt: z.string().datetime(),
    })
    .optional(),
  traceId: z.string().min(1),
  parentJobId: objectIdSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  createdBy: z.string().min(1),
});
export type Job = z.infer<typeof jobSchema>;

export const eventTypeSchema = z.enum([
  'route.resolved',
  'provider.attempt',
  'provider.retry',
  'provider.fallback',
  'token.delta',
  'job.created',
  'job.started',
  'job.progress',
  'job.blocked',
  'job.completed',
  'job.failed',
  'job.cancelled',
  'permission.asked',
  'permission.decided',
  'artefact.written',
  'trace.failed',
]);
export type EventType = z.infer<typeof eventTypeSchema>;

export const eventEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  id: objectIdSchema,
  traceId: z.string().min(1),
  jobId: objectIdSchema.optional(),
  projectId: objectIdSchema.optional(),
  type: eventTypeSchema,
  ts: z.string().datetime(),
  payload: z.record(z.unknown()),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
