import { z } from 'zod';

/** Persistent schema epoch. Bump only with a migration. */
export const CONTRACTS_SCHEMA_VERSION = 1 as const;

export const objectTypeSchema = z.enum([
  'project',
  'file',
  'artefact',
  'job',
  'conversation',
  'site',
  'chapter',
  'character',
  'research_item',
  'evidence_item',
  'deployment',
  'model',
  'event',
  'blob',
  'manifest',
  'provider',
  'trace',
]);
export type ObjectType = z.infer<typeof objectTypeSchema>;

/**
 * Stable universal object id: `at_<type>_<id>`.
 * `<id>` is a ULID/UUID-shaped token; generators live in platform packages.
 */
export const objectIdSchema = z
  .string()
  .regex(
    /^at_[a-z_]+_[0-9A-HJKMNP-TV-Z]{26}$|^at_[a-z_]+_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'ObjectId must be at_<type>_<ulid-or-uuid>',
  );
export type ObjectId = z.infer<typeof objectIdSchema>;

export function objectIdType(id: ObjectId): string {
  const parts = id.split('_');
  return parts[1] ?? '';
}

export const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export type Digest = z.infer<typeof digestSchema>;
