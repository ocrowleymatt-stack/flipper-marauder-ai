import { z } from 'zod';

/**
 * Compiled working-set contracts.
 *
 * A model invocation receives a deliberately constructed working set.
 * Durable history stays in Projects/CAS/retrieval/provenance — this module
 * never dumps an entire conversation or evidence estate into a prompt, and it
 * does not name providers on generic items.
 */

export const compiledContextKindSchema = z.enum([
  'objective',
  'policy',
  'structured_state',
  'evidence',
  'history',
  'output_contract',
]);
export type CompiledContextKind = z.infer<typeof compiledContextKindSchema>;

export const compiledContextItemSchema = z.object({
  id: z.string().min(1),
  kind: compiledContextKindSchema,
  tokenCost: z.number().int().nonnegative(),
  inclusionReason: z.string().min(1),
  content: z.string(),
  sourceRef: z.string().nullable(),
});
export type CompiledContextItem = z.infer<typeof compiledContextItemSchema>;

export const compiledOmittedItemSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
});
export type CompiledOmittedItem = z.infer<typeof compiledOmittedItemSchema>;

export const compiledWorkingSetSchema = z.object({
  objective: z.string(),
  policyExcerpt: z.string(),
  items: z.array(compiledContextItemSchema),
  tokenCount: z.number().int().nonnegative(),
  tokenBudget: z.number().int().nonnegative(),
  truncated: z.boolean(),
  omitted: z.array(compiledOmittedItemSchema),
});
export type CompiledWorkingSet = z.infer<typeof compiledWorkingSetSchema>;

export const compiledContextEvidenceItemSchema = z.object({
  id: z.string().min(1).optional(),
  content: z.string(),
  sourceRef: z.string().nullable().optional(),
});
export type CompiledContextEvidenceItem = z.infer<typeof compiledContextEvidenceItemSchema>;

/** Failed attempts are valid history; the compiler drops them unless `attemptId` is set. */
export const compiledContextHistoryItemSchema = z.object({
  id: z.string().min(1).optional(),
  attemptId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  irrelevant: z.boolean().optional(),
  content: z.string().optional(),
});
export type CompiledContextHistoryItem = z.infer<typeof compiledContextHistoryItemSchema>;

export const contextCompileRequestSchema = z.object({
  objective: z.string().min(1),
  tokenBudget: z.number().int().nonnegative(),
  /** When set, the matching failed/irrelevant history item is kept. */
  attemptId: z.string().min(1).optional(),
  structuredState: z.unknown().optional(),
  evidence: z.array(compiledContextEvidenceItemSchema).optional(),
  policy: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  history: z.array(compiledContextHistoryItemSchema).optional(),
  outputContract: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
});
export type ContextCompileRequest = z.infer<typeof contextCompileRequestSchema>;
