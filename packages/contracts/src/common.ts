import { z } from 'zod';

/** All persisted contracts in this package are currently at schema version 1. */
export const SCHEMA_VERSION = 1 as const;
export const SchemaVersion = z.literal(SCHEMA_VERSION);

/** ISO 8601 timestamp with an explicit offset or `Z`, e.g. `2026-09-13T18:53:00.000Z`. */
export const IsoTimestamp = z.iso.datetime({ offset: true });
export type IsoTimestamp = z.infer<typeof IsoTimestamp>;

/** Lowercase dotted name with at least two segments, e.g. `job.progress.updated`. */
export const DottedName = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/,
    'expected a lowercase dotted name such as "job.progress.updated"',
  );
export type DottedName = z.infer<typeof DottedName>;

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase sha256 hex digest');
export type Sha256Hex = z.infer<typeof Sha256Hex>;

export const NonEmptyString = z.string().min(1);
