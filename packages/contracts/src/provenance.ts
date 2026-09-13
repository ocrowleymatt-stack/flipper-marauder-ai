import { z } from 'zod';
import { IsoTimestamp, NonEmptyString, SchemaVersion, Sha256Hex } from './common.js';
import { AnyAtlasId, atlasId } from './ids.js';

export const ModelRef = z.object({
  provider: NonEmptyString,
  model: NonEmptyString,
});
export type ModelRef = z.infer<typeof ModelRef>;

export const SourceInput = z.object({
  objectId: AnyAtlasId,
  revisionId: atlasId('rev'),
});
export type SourceInput = z.infer<typeof SourceInput>;

/** Tool inputs/outputs are referenced by digest so provenance stays small and content stays in storage. */
export const ToolCallRecord = z.object({
  name: NonEmptyString,
  startedAt: IsoTimestamp,
  finishedAt: IsoTimestamp.optional(),
  outcome: z.enum(['succeeded', 'failed', 'denied']),
  argumentsDigest: Sha256Hex.optional(),
  resultDigest: Sha256Hex.optional(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecord>;

export const ProvenanceEdit = z.object({
  at: IsoTimestamp,
  by: z.object({
    kind: z.enum(['user', 'model', 'tool']),
    id: z.string().optional(),
  }),
  description: z.string().optional(),
});
export type ProvenanceEdit = z.infer<typeof ProvenanceEdit>;

export const Provenance = z.object({
  schemaVersion: SchemaVersion,
  projectId: atlasId('prj'),
  sourceInputs: z.array(SourceInput),
  model: ModelRef.optional(),
  toolCalls: z.array(ToolCallRecord),
  jobId: atlasId('job'),
  createdAt: IsoTimestamp,
  edits: z.array(ProvenanceEdit).optional(),
});
export type Provenance = z.infer<typeof Provenance>;
