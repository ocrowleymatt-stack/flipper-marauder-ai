import { z } from 'zod';
import { IsoTimestamp, NonEmptyString, SchemaVersion } from './common.js';
import { atlasId } from './ids.js';
import { ModelRef } from './provenance.js';

export const CAPABILITY_ALIASES = [
  'nexus/fast',
  'nexus/reason',
  'nexus/code',
  'nexus/vision',
  'nexus/cheap',
  'nexus/local',
  'nexus/frontier',
] as const;
export const CapabilityAlias = z.enum(CAPABILITY_ALIASES);
export type CapabilityAlias = z.infer<typeof CapabilityAlias>;

export const ModelCapabilities = z.object({
  text: z.boolean(),
  reasoning: z.boolean(),
  tools: z.boolean(),
  vision: z.boolean(),
  code: z.boolean(),
  streaming: z.boolean(),
  json: z.boolean(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilities>;

export const COST_CLASSES = ['low', 'medium', 'high'] as const;
export const CostClass = z.enum(COST_CLASSES);
export type CostClass = z.infer<typeof CostClass>;

export const LatencyClass = z.enum(COST_CLASSES);
export type LatencyClass = z.infer<typeof LatencyClass>;

export const Locality = z.enum(['local', 'cloud', 'private']);
export type Locality = z.infer<typeof Locality>;

export const ModelHealth = z.enum(['healthy', 'degraded', 'unhealthy', 'unknown']);
export type ModelHealth = z.infer<typeof ModelHealth>;

export const ModelDescriptor = ModelRef.extend({
  capabilities: ModelCapabilities,
  contextWindow: z.number().int().positive(),
  costClass: CostClass,
  latencyClass: LatencyClass,
  locality: Locality,
  health: ModelHealth,
});
export type ModelDescriptor = z.infer<typeof ModelDescriptor>;

export const RouteRequirements = z.object({
  tools: z.boolean().optional(),
  vision: z.boolean().optional(),
  minContext: z.number().int().positive().optional(),
  localOnly: z.boolean().optional(),
  maxCostClass: CostClass.optional(),
});
export type RouteRequirements = z.infer<typeof RouteRequirements>;

/** Per-request overrides of the router's configured policy. Absent fields mean "use the configured value". */
export const RoutePolicy = z.object({
  allowProviders: z.array(NonEmptyString).optional(),
  denyProviders: z.array(NonEmptyString).optional(),
  allowDegraded: z.boolean().optional(),
  preferLocality: Locality.optional(),
  maxLatencyClass: LatencyClass.optional(),
});
export type RoutePolicy = z.infer<typeof RoutePolicy>;

export const RouteTarget = z.union([
  z.object({ alias: CapabilityAlias }),
  z.object({ model: ModelRef }),
]);
export type RouteTarget = z.infer<typeof RouteTarget>;

export const RouteRequest = z.object({
  traceId: atlasId('trace').optional(),
  target: RouteTarget,
  requirements: RouteRequirements.default({}),
  policy: RoutePolicy.default({}),
});
export type RouteRequest = z.infer<typeof RouteRequest>;
export type RouteRequestInput = z.input<typeof RouteRequest>;

export const RouteExclusion = z.object({
  model: ModelRef,
  reason: NonEmptyString,
});
export type RouteExclusion = z.infer<typeof RouteExclusion>;

export const RouteTrace = z.object({
  schemaVersion: SchemaVersion,
  traceId: atlasId('trace'),
  requestedAlias: CapabilityAlias.optional(),
  requestedModel: ModelRef.optional(),
  consideredModels: z.array(ModelRef),
  excluded: z.array(RouteExclusion),
  chosen: ModelRef,
  policy: RoutePolicy,
  timestamp: IsoTimestamp,
});
export type RouteTrace = z.infer<typeof RouteTrace>;

const sameModel = (a: ModelRef, b: ModelRef): boolean => a.provider === b.provider && a.model === b.model;

export const RouteDecision = z
  .object({
    candidates: z.array(ModelDescriptor).min(1),
    chosen: ModelDescriptor,
    trace: RouteTrace,
  })
  .superRefine((decision, ctx) => {
    if (!decision.candidates.some((c) => sameModel(c, decision.chosen))) {
      ctx.addIssue({ code: 'custom', path: ['chosen'], message: 'chosen model must be one of the candidates' });
    }
    if (!sameModel(decision.trace.chosen, decision.chosen)) {
      ctx.addIssue({ code: 'custom', path: ['trace', 'chosen'], message: 'trace.chosen must match chosen' });
    }
  });
export type RouteDecision = z.infer<typeof RouteDecision>;
