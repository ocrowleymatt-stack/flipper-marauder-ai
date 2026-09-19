import { z } from 'zod';

export const searchHitSchema = z.object({
  engine: z.string().min(1),
  title: z.string().min(1),
  url: z.string().min(1),
  canonicalUrl: z.string().min(1),
  snippet: z.string(),
  rank: z.number().int().positive(),
  retrievedAt: z.string(),
  source: z.string().nullable().optional(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchEngineErrorSchema = z.object({
  engine: z.string().min(1),
  message: z.string().min(1),
});
export type SearchEngineError = z.infer<typeof searchEngineErrorSchema>;

export const searchReportSchema = z.object({
  query: z.string().min(1),
  hits: z.array(searchHitSchema),
  engines: z.array(z.string()),
  errors: z.array(searchEngineErrorSchema),
  retrievedAt: z.string(),
});
export type SearchReport = z.infer<typeof searchReportSchema>;

export const inspectedSourceSchema = z.object({
  requestedUrl: z.string().min(1),
  finalUrl: z.string().min(1),
  status: z.number().int(),
  ok: z.boolean(),
  contentType: z.string(),
  text: z.string(),
  contentHash: z.string(),
  fetchedAt: z.string(),
  truncated: z.boolean().default(false),
});
export type InspectedSource = z.infer<typeof inspectedSourceSchema>;

export const researchFindingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  url: z.string().min(1),
  canonicalUrl: z.string().min(1),
  summary: z.string(),
  quote: z.string().optional(),
  engine: z.string().min(1),
  host: z.string().min(1),
  confidence: z.enum(['confirmed', 'likely', 'possible']),
  wave: z.number().int().positive(),
});
export type ResearchFinding = z.infer<typeof researchFindingSchema>;

export const contradictionRecordSchema = z.object({
  topic: z.string().min(1),
  left: z.string().min(1),
  right: z.string().min(1),
});
export type ContradictionRecord = z.infer<typeof contradictionRecordSchema>;

export interface FederatedSearchPort {
  search(input: {
    query: string;
    count?: number;
    signal?: AbortSignal;
  }): Promise<SearchReport>;
}

export interface SourceInspectPort {
  inspect(input: { url: string; signal?: AbortSignal }): Promise<InspectedSource>;
}

/** Host-injected HTML generation. Dungeons must not call Execution or fetch. */
export interface SiteGeneratePort {
  generateHtml(input: {
    brief: string;
    signal?: AbortSignal;
  }): Promise<{ html: string; model?: string }>;
}

export interface ConversationHistoryTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}
