import { z } from 'zod';

import { capabilityAliasSchema } from './providers.js';

export const explicitTargetSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
});
export type ExplicitTarget = z.infer<typeof explicitTargetSchema>;

export const routeRequirementsSchema = z.object({
  text: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  tools: z.boolean().optional(),
  vision: z.boolean().optional(),
  code: z.boolean().optional(),
  minContextWindow: z.number().int().positive().optional(),
});
export type RouteRequirements = z.infer<typeof routeRequirementsSchema>;

export const costPreferenceSchema = z.enum(['cheapest', 'balanced', 'frontier']);
export type CostPreference = z.infer<typeof costPreferenceSchema>;

export const routePolicySchema = z.object({
  localOnly: z.boolean().optional(),
  costPreference: costPreferenceSchema.optional(),
  includeFlagged: z.boolean().optional(),
});
export type RoutePolicy = z.infer<typeof routePolicySchema>;

export const routeRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    alias: capabilityAliasSchema.optional(),
    explicit: explicitTargetSchema.optional(),
    requirements: routeRequirementsSchema.optional(),
    policy: routePolicySchema.optional(),
    traceId: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.alias || value.explicit), {
    message: 'RouteRequest requires alias or explicit target',
  });
export type RouteRequest = z.infer<typeof routeRequestSchema>;

export const exclusionReasonSchema = z.enum([
  'unhealthy',
  'locality',
  'capability',
  'context_window',
  'flagged',
  'unknown',
  'explicit_unhealthy',
]);
export type ExclusionReason = z.infer<typeof exclusionReasonSchema>;

export const routeCandidateSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  reason: z.string().min(1),
});
export type RouteCandidate = z.infer<typeof routeCandidateSchema>;

export const routeExclusionSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  reason: exclusionReasonSchema,
});
export type RouteExclusion = z.infer<typeof routeExclusionSchema>;

export const routeErrorCodeSchema = z.enum([
  'route.invalid_request',
  'route.unknown_alias',
  'route.unknown_target',
  'route.no_candidate',
  'route.locality_violation',
  'route.explicit_unhealthy',
  'route.capability_mismatch',
]);
export type RouteErrorCode = z.infer<typeof routeErrorCodeSchema>;

export const routeTraceSchema = z.object({
  schemaVersion: z.literal(1),
  traceId: z.string().min(1),
  alias: capabilityAliasSchema.nullable(),
  explicit: explicitTargetSchema.nullable(),
  aliasIgnored: z.boolean(),
  attempted: z.array(z.string()),
  excluded: z.array(routeExclusionSchema),
  selected: z.array(z.string()),
  ts: z.string().datetime(),
});
export type RouteTrace = z.infer<typeof routeTraceSchema>;

export const routeDecisionSchema = z.object({
  schemaVersion: z.literal(1),
  candidates: z.array(routeCandidateSchema).min(1),
  trace: routeTraceSchema,
});
export type RouteDecision = z.infer<typeof routeDecisionSchema>;
