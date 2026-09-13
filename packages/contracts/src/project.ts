import { z } from 'zod';
import { ActorRef, BlobRef, IsoTimestamp, Metadata, NonEmptyString, Uuid } from './primitives.js';
import { ContractVersion } from './version.js';

export const PROJECT_STATUSES = ['draft', 'active', 'suspended', 'archived'] as const;

export const ProjectStatus = z.enum(PROJECT_STATUSES);

export const ProjectSlug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug')
  .min(1)
  .max(96);

export const ProjectAggregate = z
  .strictObject({
    id: Uuid,
    contractVersion: ContractVersion,
    slug: ProjectSlug.describe('Stable, human-usable handle. Immutable once assigned.'),
    name: NonEmptyString.max(256),
    status: ProjectStatus,
    owner: ActorRef,
    createdAt: IsoTimestamp,
    updatedAt: IsoTimestamp,
    /**
     * Optimistic-concurrency token. Writers must supply the version they read;
     * the store rejects the write if it has moved on. This is what makes the
     * aggregate safe to mutate from both the edge and the broker.
     */
    version: z.number().int().nonnegative(),
    artifacts: z.array(BlobRef).describe('Content-addressed outputs currently attached.'),
    metadata: Metadata.optional(),
  })
  .describe('The consistency boundary for everything a user owns.');

export type ProjectStatus = z.infer<typeof ProjectStatus>;
export type ProjectSlug = z.infer<typeof ProjectSlug>;
export type ProjectAggregate = z.infer<typeof ProjectAggregate>;
