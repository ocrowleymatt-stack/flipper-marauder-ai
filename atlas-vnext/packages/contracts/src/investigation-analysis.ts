import { z } from 'zod';
import {
  claimSchema,
  entityKindSchema,
  evidenceLinkRoleSchema,
  epistemicProducerSchema,
  sourceLocationSchema,
} from './evidence.ts';

/**
 * Investigation A2 analysis contracts.
 *
 * These are derived views and reversible analysis objects. They do not promote
 * assertions, inferences, or hypotheses to facts. Generic items never name
 * providers.
 */

const provenanceBase = {
  id: z.string().min(1),
  caseId: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).default([]),
  generation: z.number().int().nonnegative(),
  staleAt: z.string().nullable(),
  staleReason: z.string().nullable(),
};

export const communicationTurnSchema = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1),
  evidenceObjectId: z.string().min(1),
  speaker: z.string().min(1),
  text: z.string(),
  occurredAt: z.string().nullable(),
  sourceLocation: sourceLocationSchema,
  epistemicClass: z.literal('source_assertion'),
});
export type CommunicationTurn = z.infer<typeof communicationTurnSchema>;

export const communicationThreadSchema = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1),
  evidenceObjectId: z.string().min(1),
  sourceId: z.string().min(1),
  title: z.string().min(1),
  turns: z.array(communicationTurnSchema),
});
export type CommunicationThread = z.infer<typeof communicationThreadSchema>;

export const chronologyItemKindSchema = z.enum(['event', 'thread_turn']);
export const chronologyItemSchema = z.object({
  id: z.string().min(1),
  kind: chronologyItemKindSchema,
  occurredAt: z.string().nullable(),
  description: z.string().min(1),
  epistemicClass: z.enum(['source_assertion', 'fact', 'inference']),
  evidenceObjectIds: z.array(z.string().min(1)).default([]),
  sourceLocation: sourceLocationSchema.optional(),
});
export type ChronologyItem = z.infer<typeof chronologyItemSchema>;

export const chronologyGroupSchema = z.object({
  date: z.string().min(1),
  items: z.array(chronologyItemSchema),
});
export type ChronologyGroup = z.infer<typeof chronologyGroupSchema>;

export const aliasCandidateStatusSchema = z.enum(['proposed', 'accepted', 'rejected', 'reverted']);
export type AliasCandidateStatus = z.infer<typeof aliasCandidateStatusSchema>;

export const aliasConfidenceBasisSchema = z.enum(['alias_overlap', 'surface_match', 'model_proposal']);
export type AliasConfidenceBasis = z.infer<typeof aliasConfidenceBasisSchema>;

export const aliasCandidateSchema = z.object({
  ...provenanceBase,
  leftEntityId: z.string().min(1),
  rightEntityId: z.string().min(1),
  surface: z.string().min(1),
  confidence: z.number().min(0).max(1),
  confidenceBasis: aliasConfidenceBasisSchema,
  producer: epistemicProducerSchema,
  status: aliasCandidateStatusSchema,
  evidenceObjectIds: z.array(z.string().min(1)).default([]),
  addedAlias: z.string().nullable(),
});
export type AliasCandidate = z.infer<typeof aliasCandidateSchema>;

export const claimMatrixCellSchema = z.object({
  claimId: z.string().min(1),
  evidenceId: z.string().min(1),
  role: evidenceLinkRoleSchema,
});
export type ClaimMatrixCell = z.infer<typeof claimMatrixCellSchema>;

export const claimMatrixSchema = z.object({
  caseId: z.string().min(1),
  claims: z.array(claimSchema),
  cells: z.array(claimMatrixCellSchema),
  unmappedEvidenceIds: z.array(z.string().min(1)),
  unsupportedClaimIds: z.array(z.string().min(1)),
});
export type ClaimMatrix = z.infer<typeof claimMatrixSchema>;

export const analysisGapKindSchema = z.enum(['unsupported_hypothesis', 'unmapped_evidence', 'unmapped_claim']);
export const analysisGapSchema = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1),
  kind: analysisGapKindSchema,
  statement: z.string().min(1),
  relatedIds: z.array(z.string().min(1)).default([]),
});
export type AnalysisGap = z.infer<typeof analysisGapSchema>;

export const analysisRelationKindSchema = z.enum(['corroboration', 'contradiction']);
export const analysisRelationSchema = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1),
  kind: analysisRelationKindSchema,
  leftId: z.string().min(1),
  rightId: z.string().min(1),
  statement: z.string().min(1),
  /** Copied from the durable record. Never upgraded. */
  epistemicClass: z.enum(['source_assertion', 'fact', 'contradiction']),
});
export type AnalysisRelation = z.infer<typeof analysisRelationSchema>;

export const hypothesisTestResultSchema = z.enum(['supported', 'unsupported', 'inconclusive', 'rejected']);
export type HypothesisTestResult = z.infer<typeof hypothesisTestResultSchema>;

export const hypothesisTestSchema = z.object({
  ...provenanceBase,
  hypothesisId: z.string().min(1),
  result: hypothesisTestResultSchema,
  method: z.literal('deterministic_coverage'),
  producer: z.literal('deterministic'),
  supportingIds: z.array(z.string().min(1)).default([]),
  contradictingIds: z.array(z.string().min(1)).default([]),
  gap: z.string().nullable(),
});
export type HypothesisTest = z.infer<typeof hypothesisTestSchema>;

export const timelineViewSchema = z.object({
  caseId: z.string().min(1),
  groups: z.array(chronologyGroupSchema),
  threads: z.array(communicationThreadSchema),
});
export type TimelineView = z.infer<typeof timelineViewSchema>;

export const networkNodeSchema = z.object({
  id: z.string().min(1),
  kind: entityKindSchema,
  canonicalName: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
  status: z.enum(['unresolved', 'resolved', 'ambiguous']),
});
export type NetworkNode = z.infer<typeof networkNodeSchema>;

export const networkEdgeSchema = z.object({
  id: z.string().min(1),
  fromId: z.string().min(1),
  toId: z.string().min(1),
  kind: z.string().min(1),
  epistemicClass: z.enum(['source_assertion', 'fact', 'inference']),
});
export type NetworkEdge = z.infer<typeof networkEdgeSchema>;

export const networkViewSchema = z.object({
  caseId: z.string().min(1),
  nodes: z.array(networkNodeSchema),
  edges: z.array(networkEdgeSchema),
  aliasCandidates: z.array(aliasCandidateSchema),
});
export type NetworkView = z.infer<typeof networkViewSchema>;

export const investigationViewsSchema = z.object({
  timeline: timelineViewSchema,
  network: networkViewSchema,
  matrix: claimMatrixSchema,
  relations: z.array(analysisRelationSchema),
  gaps: z.array(analysisGapSchema),
  hypothesisTests: z.array(hypothesisTestSchema),
});
export type InvestigationViews = z.infer<typeof investigationViewsSchema>;

export const analysisFocusSchema = z.enum(['contradiction', 'hypothesis', 'claim', 'finding']);
export type AnalysisFocus = z.infer<typeof analysisFocusSchema>;

