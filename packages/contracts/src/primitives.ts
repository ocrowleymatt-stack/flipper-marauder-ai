import { z } from 'zod';

/** Lowercase dotted/dashed identifier, e.g. `device.transport`, `nexus-router`. */
export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;

/** `sha256:` followed by 64 lowercase hex characters. */
export const CONTENT_ADDRESS_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** `<kind>:<uuid>`, the shape of an ordered event stream key. */
export const STREAM_ID_PATTERN =
  /^(?:project|job):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const Uuid = z.uuid().describe('RFC 4122 UUID.');

export const IsoTimestamp = z.iso
  .datetime({ offset: true })
  .describe('RFC 3339 / ISO 8601 timestamp.');

export const NonEmptyString = z.string().min(1);

export const Identifier = z
  .string()
  .regex(IDENTIFIER_PATTERN, 'must be a lowercase dotted identifier')
  .max(128);

export const Metadata = z
  .record(z.string(), z.unknown())
  .describe('Free-form, JSON-serialisable annotations. Never load-bearing for control flow.');

export const Sequence = z
  .number()
  .int()
  .nonnegative()
  .describe('Monotonic, gap-free position within a single stream.');

export const StreamId = z
  .string()
  .regex(STREAM_ID_PATTERN, 'must be `project:<uuid>` or `job:<uuid>`')
  .describe('Ordering key for an event stream.');

export const ContentAddress = z
  .string()
  .regex(CONTENT_ADDRESS_PATTERN, 'must be `sha256:<64 lowercase hex chars>`')
  .describe('Multihash-style content address. The only way to name bytes in Atlas.');

export const BlobRef = z
  .strictObject({
    address: ContentAddress,
    sizeBytes: z.number().int().nonnegative(),
    mediaType: NonEmptyString.max(255).describe('IANA media type of the addressed bytes.'),
  })
  .describe('A reference to immutable bytes held in content-addressed storage.');

export const ACTOR_KINDS = ['user', 'service', 'module', 'system'] as const;

export const ActorKind = z.enum(ACTOR_KINDS);

export const ActorRef = z
  .strictObject({
    kind: ActorKind,
    id: NonEmptyString.max(256),
    displayName: NonEmptyString.max(256).optional(),
  })
  .describe('Who or what caused something to happen.');

export type Uuid = z.infer<typeof Uuid>;
export type IsoTimestamp = z.infer<typeof IsoTimestamp>;
export type Identifier = z.infer<typeof Identifier>;
export type Metadata = z.infer<typeof Metadata>;
export type Sequence = z.infer<typeof Sequence>;
export type StreamId = z.infer<typeof StreamId>;
export type ContentAddress = z.infer<typeof ContentAddress>;
export type BlobRef = z.infer<typeof BlobRef>;
export type ActorKind = z.infer<typeof ActorKind>;
export type ActorRef = z.infer<typeof ActorRef>;

/** Build the canonical stream id for a project's ordered event stream. */
export function projectStreamId(projectId: string): StreamId {
  return `project:${projectId}`;
}

/** Build the canonical stream id for a job's ordered event stream. */
export function jobStreamId(jobId: string): StreamId {
  return `job:${jobId}`;
}
