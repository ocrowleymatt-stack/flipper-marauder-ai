import { z } from 'zod';

export const providerHealthSchema = z.enum(['healthy', 'degraded', 'unhealthy', 'unknown']);
export type ProviderHealth = z.infer<typeof providerHealthSchema>;

export const localitySchema = z.enum(['local', 'cloud']);
export type Locality = z.infer<typeof localitySchema>;

export const costClassSchema = z.enum(['zero', 'low', 'medium', 'high']);
export type CostClass = z.infer<typeof costClassSchema>;

export const latencyClassSchema = z.enum(['low', 'medium', 'high']);
export type LatencyClass = z.infer<typeof latencyClassSchema>;

export const modelCapabilitiesSchema = z.object({
  text: z.boolean().default(true),
  reasoning: z.boolean().default(false),
  tools: z.boolean().default(false),
  vision: z.boolean().default(false),
  code: z.boolean().default(false),
});
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

export const providerRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().min(1),
  locality: localitySchema,
  health: providerHealthSchema,
});
export type ProviderRecord = z.infer<typeof providerRecordSchema>;

export const modelRecordSchema = z.object({
  schemaVersion: z.literal(1),
  providerId: z.string().min(1),
  id: z.string().min(1),
  label: z.string().min(1),
  capabilities: modelCapabilitiesSchema,
  contextWindow: z.number().int().positive(),
  costClass: costClassSchema,
  latencyClass: latencyClassSchema,
  locality: localitySchema,
  health: providerHealthSchema,
  flagged: z.boolean().default(false),
});
export type ModelRecord = z.infer<typeof modelRecordSchema>;

export const providerRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  providers: z.array(providerRecordSchema),
  models: z.array(modelRecordSchema),
});
export type ProviderRegistry = z.infer<typeof providerRegistrySchema>;

export const capabilityAliasSchema = z.enum([
  'nexus/fast',
  'nexus/reason',
  'nexus/code',
  'nexus/vision',
  'nexus/cheap',
  'nexus/local',
  'nexus/frontier',
]);
export type CapabilityAlias = z.infer<typeof capabilityAliasSchema>;

export const CAPABILITY_ALIASES = capabilityAliasSchema.options;
