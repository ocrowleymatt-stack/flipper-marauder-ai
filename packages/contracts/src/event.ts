import { z } from 'zod';
import { JobError, JobState } from './job.js';
import {
  ActorRef,
  BlobRef,
  Identifier,
  IsoTimestamp,
  Metadata,
  NonEmptyString,
  Sequence,
  StreamId,
  Uuid,
} from './primitives.js';
import { ProjectStatus } from './project.js';
import { ContractVersion } from './version.js';

// ---------------------------------------------------------------- project
const ProjectCreated = z.strictObject({
  type: z.literal('project.created'),
  projectId: Uuid,
  slug: NonEmptyString,
  name: NonEmptyString,
  status: ProjectStatus,
});

const ProjectUpdated = z.strictObject({
  type: z.literal('project.updated'),
  projectId: Uuid,
  version: z.number().int().nonnegative(),
  changedFields: z.array(Identifier).min(1),
});

const ProjectArchived = z.strictObject({
  type: z.literal('project.archived'),
  projectId: Uuid,
  reason: NonEmptyString.optional(),
});

// ------------------------------------------------------------ job lifecycle
const JobEnqueued = z.strictObject({
  type: z.literal('job.enqueued'),
  jobId: Uuid,
  jobType: Identifier,
  projectId: Uuid,
  commandId: Uuid,
  availableAt: IsoTimestamp,
});

const JobLeased = z.strictObject({
  type: z.literal('job.leased'),
  jobId: Uuid,
  leaseId: Uuid,
  holder: NonEmptyString,
  expiresAt: IsoTimestamp,
});

const JobStarted = z.strictObject({
  type: z.literal('job.started'),
  jobId: Uuid,
  attempt: z.number().int().min(1),
});

const JobSucceeded = z.strictObject({
  type: z.literal('job.succeeded'),
  jobId: Uuid,
  attempt: z.number().int().min(1),
  outputs: z.array(BlobRef),
});

const JobFailed = z.strictObject({
  type: z.literal('job.failed'),
  jobId: Uuid,
  attempt: z.number().int().min(1),
  error: JobError,
  terminal: z.boolean().describe('False when a retry has been scheduled.'),
});

const JobRetryScheduled = z.strictObject({
  type: z.literal('job.retry_scheduled'),
  jobId: Uuid,
  attempt: z.number().int().min(1),
  availableAt: IsoTimestamp,
  delayMs: z.number().int().nonnegative(),
});

const JobCancelled = z.strictObject({
  type: z.literal('job.cancelled'),
  jobId: Uuid,
  requestedBy: ActorRef,
  previousState: JobState,
  reason: NonEmptyString.optional(),
});

const JobLeaseExpired = z.strictObject({
  type: z.literal('job.lease_expired'),
  jobId: Uuid,
  leaseId: Uuid,
  holder: NonEmptyString,
});

// ----------------------------------------------------------- step progress
const StepStarted = z.strictObject({
  type: z.literal('step.started'),
  jobId: Uuid,
  stepId: Uuid,
  name: Identifier,
  moduleId: Identifier.optional(),
});

const StepProgress = z.strictObject({
  type: z.literal('step.progress'),
  jobId: Uuid,
  stepId: Uuid,
  ratio: z.number().min(0).max(1),
  message: NonEmptyString.max(1000).optional(),
});

const StepCompleted = z.strictObject({
  type: z.literal('step.completed'),
  jobId: Uuid,
  stepId: Uuid,
  outputs: z.array(BlobRef),
});

const StepFailed = z.strictObject({
  type: z.literal('step.failed'),
  jobId: Uuid,
  stepId: Uuid,
  error: JobError,
});

// --------------------------------------------------------------- artifacts
const ArtifactProduced = z.strictObject({
  type: z.literal('artifact.produced'),
  jobId: Uuid,
  projectId: Uuid,
  role: Identifier.describe('What this artifact is for, e.g. `capture`, `report`.'),
  blob: BlobRef,
});

const ArtifactReferenced = z.strictObject({
  type: z.literal('artifact.referenced'),
  jobId: Uuid,
  projectId: Uuid,
  blob: BlobRef,
});

export const EVENT_PAYLOAD_SCHEMAS = [
  ProjectCreated,
  ProjectUpdated,
  ProjectArchived,
  JobEnqueued,
  JobLeased,
  JobStarted,
  JobSucceeded,
  JobFailed,
  JobRetryScheduled,
  JobCancelled,
  JobLeaseExpired,
  StepStarted,
  StepProgress,
  StepCompleted,
  StepFailed,
  ArtifactProduced,
  ArtifactReferenced,
] as const;

export const EventPayload = z.discriminatedUnion('type', EVENT_PAYLOAD_SCHEMAS);

/**
 * The closed set of event type names. Kept as a literal array (rather than
 * derived at runtime) so that adding an event is a visible contract change and
 * shows up in the emitted JSON Schema diff.
 */
export const EVENT_TYPES = [
  'project.created',
  'project.updated',
  'project.archived',
  'job.enqueued',
  'job.leased',
  'job.started',
  'job.succeeded',
  'job.failed',
  'job.retry_scheduled',
  'job.cancelled',
  'job.lease_expired',
  'step.started',
  'step.progress',
  'step.completed',
  'step.failed',
  'artifact.produced',
  'artifact.referenced',
] as const;

export const EventType = z.enum(EVENT_TYPES);

export const EventCorrelation = z
  .strictObject({
    commandId: Uuid.optional(),
    jobId: Uuid.optional(),
    projectId: Uuid.optional(),
    causationId: Uuid.optional().describe('The event that directly caused this one.'),
  })
  .describe('How this event relates to the rest of the causal graph.');

export const EventEnvelope = z
  .strictObject({
    id: Uuid,
    contractVersion: ContractVersion,
    streamId: StreamId,
    /**
     * Assigned by the event store, not the producer. Consumers resume by
     * sequence, so it must be gap-free and strictly increasing per stream.
     */
    sequence: Sequence,
    occurredAt: IsoTimestamp.describe('When the fact became true in the producer.'),
    recordedAt: IsoTimestamp.describe('When the store durably accepted it.'),
    producer: ActorRef,
    correlation: EventCorrelation,
    payload: EventPayload,
    metadata: Metadata.optional(),
  })
  .describe('The only way Atlas tells anyone what happened.');

export type EventType = z.infer<typeof EventType>;
export type EventPayload = z.infer<typeof EventPayload>;
export type EventCorrelation = z.infer<typeof EventCorrelation>;
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** An event payload plus everything the store does not assign for you. */
export type UnsequencedEvent = Omit<EventEnvelope, 'sequence' | 'recordedAt'>;

export type EventPayloadOfType<T extends EventType> = Extract<EventPayload, { type: T }>;
