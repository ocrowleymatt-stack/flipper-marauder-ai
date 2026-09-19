import { z } from 'zod';

export const searchModeSchema = z.enum(['search', 'research', 'deep']);
export type SearchMode = z.infer<typeof searchModeSchema>;

export const searchSourceTypeSchema = z.enum([
  'official',
  'academic',
  'code',
  'discussion',
  'encyclopedia',
  'general',
]);
export type SearchSourceType = z.infer<typeof searchSourceTypeSchema>;

export const searchHitSchema = z.object({
  rank: z.number().int().nonnegative(),
  title: z.string().min(1),
  url: z.string().min(1),
  canonicalUrl: z.string().min(1),
  snippet: z.string(),
  engine: z.string().min(1),
  sourceType: searchSourceTypeSchema,
  engineCount: z.number().int().positive().default(1),
  engines: z.array(z.string().min(1)).default([]),
  retrievedAt: z.string().min(1),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchCoverageSchema = z.object({
  score: z.number().min(0).max(100),
  engineCount: z.number().int().nonnegative(),
  hitCount: z.number().int().nonnegative(),
  primaryLike: z.number().int().nonnegative(),
  gaps: z.array(z.string()),
});
export type SearchCoverage = z.infer<typeof searchCoverageSchema>;

export const searchReportSchema = z.object({
  queries: z.array(z.string().min(1)),
  mode: searchModeSchema,
  engines: z.array(z.string().min(1)),
  hits: z.array(searchHitSchema),
  coverage: searchCoverageSchema,
  retrievedAt: z.string().min(1),
});
export type SearchReport = z.infer<typeof searchReportSchema>;

export const inspectedSourceSchema = z.object({
  url: z.string().min(1),
  canonicalUrl: z.string().min(1),
  title: z.string(),
  excerpt: z.string(),
  status: z.number().int().nullable(),
  retrievedAt: z.string().min(1),
});
export type InspectedSource = z.infer<typeof inspectedSourceSchema>;

export const claimRecordSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  supportUrls: z.array(z.string()),
  confidence: z.enum(['confirmed', 'likely', 'possible', 'unknown']),
});
export type ClaimRecord = z.infer<typeof claimRecordSchema>;

export const contradictionRecordSchema = z.object({
  a: z.string().min(1),
  b: z.string().min(1),
  reason: z.string().min(1),
});
export type ContradictionRecord = z.infer<typeof contradictionRecordSchema>;
