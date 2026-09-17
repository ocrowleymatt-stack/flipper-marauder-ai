import { z } from 'zod';

/**
 * Shared evidential language.
 *
 * FACT, SOURCE ASSERTION, INFERENCE, HYPOTHESIS, and CONTRADICTION are disjoint
 * classes. An AI-generated inference must never silently become a fact.
 * Investigation consumes these types; acquisition may later emit evidence
 * objects that point at CAS originals. This module does not name providers.
 */

export const EPISTEMIC_CLASSES = [
  'fact',
  'source_assertion',
  'inference',
  'hypothesis',
  'contradiction',
] as const;
export const epistemicClassSchema = z.enum(EPISTEMIC_CLASSES);
export type EpistemicClass = z.infer<typeof epistemicClassSchema>;

export const epistemicProducerSchema = z.enum(['human', 'deterministic', 'model']);
export type EpistemicProducer = z.infer<typeof epistemicProducerSchema>;

export const evidenceSourceKindSchema = z.enum([
  'file',
  'document',
  'transcript',
  'message_export',
  'call_record',
  'image',
  'structured_export',
  'device_derived',
  'directory',
  'other',
]);
export type EvidenceSourceKind = z.infer<typeof evidenceSourceKindSchema>;

export const evidenceObjectKindSchema = z.enum([
  'document',
  'transcript',
  'message',
  'call_record',
  'image',
  'metadata',
  'structured_row',
  'other',
]);
export type EvidenceObjectKind = z.infer<typeof evidenceObjectKindSchema>;

export const entityKindSchema = z.enum([
  'person',
  'organisation',
  'account',
  'device',
  'location',
  'vehicle',
  'other',
]);
export type EntityKind = z.infer<typeof entityKindSchema>;

export const evidenceLinkRoleSchema = z.enum([
  'supports',
  'contradicts',
  'corroborates',
  'derived_from',
  'mentions',
]);
export type EvidenceLinkRole = z.infer<typeof evidenceLinkRoleSchema>;

const sha256HexSchema = z.string().length(64).regex(/^[0-9a-f]{64}$/);

export const sourceLocationSchema = z.object({
  fileId: z.string().nullable(),
  casHash: sha256HexSchema.nullable(),
  path: z.string().nullable(),
  page: z.number().int().nonnegative().nullable(),
  offsetStart: z.number().int().nonnegative().nullable(),
  offsetEnd: z.number().int().nonnegative().nullable(),
  uri: z.string().nullable(),
  timestampStart: z.string().nullable(),
  timestampEnd: z.string().nullable(),
  messageId: z.string().nullable(),
});
export type SourceLocation = z.infer<typeof sourceLocationSchema>;

export const emptySourceLocation = (): SourceLocation => ({
  fileId: null,
  casHash: null,
  path: null,
  page: null,
  offsetStart: null,
  offsetEnd: null,
  uri: null,
  timestampStart: null,
  timestampEnd: null,
  messageId: null,
});

const provenanceBase = {
  id: z.string().min(1),
  caseId: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).default([]),
  generation: z.number().int().nonnegative(),
  staleAt: z.string().nullable(),
  staleReason: z.string().nullable(),
};

export const evidenceSourceSchema = z.object({
  ...provenanceBase,
  kind: evidenceSourceKindSchema,
  title: z.string().min(1),
  fileId: z.string().nullable(),
  originalCasHash: sha256HexSchema,
  acquiredFrom: z.string().min(1),
  acquiredAt: z.string().min(1),
});
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

export const evidenceObjectSchema = z.object({
  ...provenanceBase,
  sourceId: z.string().min(1),
  kind: evidenceObjectKindSchema,
  title: z.string().min(1),
  /** Immutable original bytes. Distinct from extractionCasHash. */
  originalCasHash: sha256HexSchema,
  /** Derived extraction / normalised form. Null when this row is the original. */
  extractionCasHash: sha256HexSchema.nullable(),
  sourceLocation: sourceLocationSchema,
  text: z.string(),
});
export type EvidenceObject = z.infer<typeof evidenceObjectSchema>;

const epistemicBase = {
  ...provenanceBase,
  statement: z.string().min(1),
  producer: epistemicProducerSchema,
  sourceLocation: sourceLocationSchema,
};

export const sourceAssertionSchema = z.object({
  ...epistemicBase,
  epistemicClass: z.literal('source_assertion'),
  assertedBy: z.string().min(1),
  evidenceObjectId: z.string().min(1),
});
export type SourceAssertion = z.infer<typeof sourceAssertionSchema>;

export const factSchema = z.object({
  ...epistemicBase,
  epistemicClass: z.literal('fact'),
  /** Facts are never produced by a model. */
  producer: z.enum(['human', 'deterministic']),
  corroboratedBy: z.array(z.string().min(1)).min(1),
});
export type Fact = z.infer<typeof factSchema>;

export const inferenceSchema = z.object({
  ...epistemicBase,
  epistemicClass: z.literal('inference'),
  producer: epistemicProducerSchema,
});
export type Inference = z.infer<typeof inferenceSchema>;

export const hypothesisSchema = z.object({
  ...epistemicBase,
  epistemicClass: z.literal('hypothesis'),
  status: z.enum(['open', 'supported', 'unsupported', 'rejected']),
});
export type Hypothesis = z.infer<typeof hypothesisSchema>;

export const contradictionSchema = z.object({
  ...epistemicBase,
  epistemicClass: z.literal('contradiction'),
  leftId: z.string().min(1),
  rightId: z.string().min(1),
});
export type Contradiction = z.infer<typeof contradictionSchema>;

export const entitySchema = z.object({
  ...provenanceBase,
  kind: entityKindSchema,
  canonicalName: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
  status: z.enum(['unresolved', 'resolved', 'ambiguous']),
});
export type EvidenceEntity = z.infer<typeof entitySchema>;

export const entityMentionSchema = z.object({
  ...provenanceBase,
  entityId: z.string().min(1),
  evidenceObjectId: z.string().min(1),
  surface: z.string().min(1),
  sourceLocation: sourceLocationSchema,
});
export type EntityMention = z.infer<typeof entityMentionSchema>;

export const evidenceEventSchema = z.object({
  ...provenanceBase,
  occurredAt: z.string().nullable(),
  occurredAtPrecision: z.enum(['unknown', 'date', 'datetime']),
  description: z.string().min(1),
  epistemicClass: z.enum(['source_assertion', 'fact', 'inference']),
  evidenceObjectIds: z.array(z.string().min(1)).default([]),
});
export type EvidenceEvent = z.infer<typeof evidenceEventSchema>;

export const relationshipSchema = z.object({
  ...provenanceBase,
  fromEntityId: z.string().min(1),
  toEntityId: z.string().min(1),
  kind: z.string().min(1),
  epistemicClass: z.enum(['source_assertion', 'fact', 'inference']),
});
export type EvidenceRelationship = z.infer<typeof relationshipSchema>;

export const claimSchema = z.object({
  ...provenanceBase,
  statement: z.string().min(1),
  kind: z.enum(['allegation', 'issue', 'question']),
});
export type EvidenceClaim = z.infer<typeof claimSchema>;

export const evidenceLinkSchema = z.object({
  ...provenanceBase,
  fromId: z.string().min(1),
  toId: z.string().min(1),
  role: evidenceLinkRoleSchema,
});
export type EvidenceLink = z.infer<typeof evidenceLinkSchema>;

export const findingSchema = z.object({
  ...provenanceBase,
  statement: z.string().min(1),
  epistemicClass: epistemicClassSchema,
  linkedIds: z.array(z.string().min(1)).default([]),
});
export type EvidenceFinding = z.infer<typeof findingSchema>;

export const INVESTIGATION_RECORD_KINDS = [
  'evidence_source',
  'evidence_object',
  'source_assertion',
  'fact',
  'inference',
  'hypothesis',
  'contradiction',
  'entity',
  'entity_mention',
  'event',
  'relationship',
  'claim',
  'evidence_link',
  'finding',
] as const;
export type InvestigationRecordKind = (typeof INVESTIGATION_RECORD_KINDS)[number];
