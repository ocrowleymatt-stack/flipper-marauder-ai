import { z } from 'zod';
import { dungeonIdSchema } from './dungeon-ids.ts';

const failureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  at: z.string(),
});

export const osintTargetKindSchema = z.enum([
  'person',
  'username',
  'email',
  'domain',
  'ip',
  'organisation',
  'other',
]);
export type OsintTargetKind = z.infer<typeof osintTargetKindSchema>;

export const osintConfidenceSchema = z.enum(['confirmed', 'likely', 'possible']);
export type OsintConfidence = z.infer<typeof osintConfidenceSchema>;

export const osintTargetSchema = z.object({
  id: z.string(),
  kind: osintTargetKindSchema,
  value: z.string().min(1),
  projectId: z.string(),
});
export type OsintTarget = z.infer<typeof osintTargetSchema>;

export const osintFindingSchema = z.object({
  id: z.string(),
  targetId: z.string(),
  jobId: z.string(),
  confidence: osintConfidenceSchema,
  source: z.string(),
  summary: z.string(),
  evidenceBlobHash: z.string().length(64).nullable(),
  provenance: z.array(z.string()),
  timestamp: z.string(),
  error: failureSchema.nullable(),
});
export type OsintFinding = z.infer<typeof osintFindingSchema>;

export const dungeonRecordStatusSchema = z.enum([
  'idle',
  'queued',
  'running',
  'waiting',
  'streaming',
  'candidate',
  'completed',
  'failed',
  'cancelled',
]);
export type DungeonRecordStatus = z.infer<typeof dungeonRecordStatusSchema>;

export const dungeonRecordSchema = z.object({
  id: z.string().min(1),
  urn: z.string().min(1),
  tenantId: z.string().min(1),
  workspaceId: z.string().nullable(),
  dungeon: dungeonIdSchema,
  kind: z.string().min(1),
  title: z.string().min(1),
  status: dungeonRecordStatusSchema,
  payload: z.record(z.string(), z.unknown()),
  artefactId: z.string().nullable(),
  contentHash: z.string().nullable(),
  jobId: z.string().nullable(),
  conversationId: z.string().nullable(),
  parentId: z.string().nullable(),
  revision: z.number().int().positive(),
  failure: failureSchema.nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
export type DungeonRecord = z.infer<typeof dungeonRecordSchema>;

export const osintScanRequestSchema = z.object({
  projectId: z.string().min(1),
  kind: osintTargetKindSchema,
  value: z.string().min(1),
  synthesize: z.boolean().optional(),
});
export type OsintScanRequest = z.infer<typeof osintScanRequestSchema>;

export const publicLookupResultSchema = z.object({
  source: z.string().min(1),
  summary: z.string().min(1),
  confidence: osintConfidenceSchema,
  evidence: z.string().min(1),
});
export type PublicLookupResult = z.infer<typeof publicLookupResultSchema>;

export const investigationChallengeSchema = z.object({
  question: z.string().min(1),
  stance: z.enum(['advocate', 'challenger', 'arbiter']),
  findingIds: z.array(z.string().min(1)).default([]),
});
export type InvestigationChallenge = z.infer<typeof investigationChallengeSchema>;
