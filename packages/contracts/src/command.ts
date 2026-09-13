import { z } from 'zod';
import { CapabilityTokenRef } from './capability.js';
import {
  ActorRef,
  Identifier,
  IsoTimestamp,
  Metadata,
  NonEmptyString,
  Uuid,
} from './primitives.js';
import { ContractVersion } from './version.js';

export const CommandType = Identifier.describe(
  'Dotted command name, e.g. `project.create` or `device.transport.scan`.',
);

/**
 * Payloads are intentionally opaque at the envelope level. The envelope is
 * universal and stable; payload shapes are owned by whichever module declares
 * the command type in its manifest, and are validated in a second pass.
 */
export const CommandEnvelope = z
  .strictObject({
    id: Uuid,
    contractVersion: ContractVersion,
    type: CommandType,
    issuedAt: IsoTimestamp,
    actor: ActorRef,
    capability: CapabilityTokenRef,
    idempotencyKey: NonEmptyString.max(200).describe(
      'Caller-supplied dedupe key. Re-submitting the same key must not create a second job.',
    ),
    projectId: Uuid.optional().describe('Absent only for commands that create a project.'),
    correlationId: Uuid.optional(),
    payload: z.unknown(),
    metadata: Metadata.optional(),
  })
  .describe('The only way to ask Atlas to do something.');

export const CommandAcceptance = z
  .strictObject({
    commandId: Uuid,
    jobId: Uuid,
    state: z.enum(['accepted', 'deduplicated']),
    streamId: NonEmptyString,
    acceptedAt: IsoTimestamp,
  })
  .describe('What the edge returns once a command has been durably enqueued.');

export type CommandType = z.infer<typeof CommandType>;
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;
export type CommandAcceptance = z.infer<typeof CommandAcceptance>;
