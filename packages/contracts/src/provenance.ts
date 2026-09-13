import { z } from 'zod';

import { digestSchema, objectIdSchema } from './ids.js';

export const provenanceSchema = z.object({
  schemaVersion: z.literal(1),
  id: objectIdSchema,
  projectId: objectIdSchema,
  artefactId: objectIdSchema.optional(),
  jobId: objectIdSchema.optional(),
  sourceInputIds: z.array(objectIdSchema),
  sourceRevisions: z.array(z.string().min(1)),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  toolCalls: z.array(
    z.object({
      toolId: z.string(),
      callId: z.string(),
      at: z.string().datetime(),
    }),
  ),
  createdAt: z.string().datetime(),
  editedFrom: objectIdSchema.optional(),
});
export type ProvenanceRecord = z.infer<typeof provenanceSchema>;

export const blobRefSchema = z.object({
  schemaVersion: z.literal(1),
  digest: digestSchema,
  sizeBytes: z.number().int().nonnegative(),
  mediaType: z.string().optional(),
});
export type BlobRef = z.infer<typeof blobRefSchema>;

export const manifestEntrySchema = z.object({
  name: z.string().min(1),
  digest: digestSchema.optional(),
  manifestId: objectIdSchema.optional(),
  mode: z.string().optional(),
});
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: objectIdSchema,
  projectId: objectIdSchema,
  blobDigest: digestSchema.optional(),
  entries: z.array(manifestEntrySchema),
  parents: z.array(objectIdSchema),
  provenanceId: objectIdSchema.optional(),
  createdAt: z.string().datetime(),
});
export type Manifest = z.infer<typeof manifestSchema>;
