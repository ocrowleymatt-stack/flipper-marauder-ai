import { z } from 'zod';

/**
 * Atlas vNext shared contracts.
 *
 * These schemas are the only shared language between Nexus (WHERE),
 * Execution (HOW), platform primitives, and future dungeons.
 * They are not a copy of Atlas Mountain's internal types.
 */

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

export const modelCapabilitiesSchema = z.object({
  text: z.boolean().default(true),
  reasoning: z.boolean().default(false),
  tools: z.boolean().default(false),
  vision: z.boolean().default(false),
  code: z.boolean().default(false),
});
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

export const costClassSchema = z.enum(['free', 'low', 'medium', 'high']);
export type CostClass = z.infer<typeof costClassSchema>;

export const latencyClassSchema = z.enum(['fast', 'medium', 'slow']);
export type LatencyClass = z.infer<typeof latencyClassSchema>;

export const localitySchema = z.enum(['local', 'cloud']);
export type Locality = z.infer<typeof localitySchema>;

export const privacyEligibilitySchema = z.enum(['any', 'local_only']);
export type PrivacyEligibility = z.infer<typeof privacyEligibilitySchema>;

export const providerHealthSchema = z.enum([
  'healthy',
  'configured',
  'unhealthy',
  'authentication_failure',
]);
export type ProviderHealth = z.infer<typeof providerHealthSchema>;

export const registeredModelSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  label: z.string().min(1),
  capabilities: modelCapabilitiesSchema,
  contextWindow: z.number().int().positive(),
  costClass: costClassSchema,
  latencyClass: latencyClassSchema,
  locality: localitySchema,
  health: providerHealthSchema.default('configured'),
  privacyEligibility: privacyEligibilitySchema.default('any'),
  runtimeRequirements: z.array(z.string().min(1)).default([]),
});
export type RegisteredModel = z.infer<typeof registeredModelSchema>;

export const routeDecisionSchema = z.object({
  target: z.string(),
  resolvedRouteId: z.string(),
  provider: z.string(),
  model: z.string(),
  candidateChain: z.array(z.string()),
  localOnly: z.boolean(),
  decisionReason: z.string(),
  traceId: z.string(),
  evaluatedAt: z.string(),
});
export type RouteDecision = z.infer<typeof routeDecisionSchema>;

export const toolCallRequestSchema = z.object({
  id: z.string(),
  toolId: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});
export type ToolCallRequest = z.infer<typeof toolCallRequestSchema>;

export const streamChunkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), call: toolCallRequestSchema }),
]);
export type StreamChunk = z.infer<typeof streamChunkSchema>;

export const capabilityScopeSchema = z.enum([
  'filesystem.read',
  'filesystem.write',
  'network.public',
  'network.private',
  'browser.control',
  'shell.execute',
  'repo.read',
  'repo.write',
  'deployment.promote',
  'secrets.use',
  'device.control',
]);
export type CapabilityScope = z.infer<typeof capabilityScopeSchema>;

export const DANGEROUS_CAPABILITY_SCOPES: readonly CapabilityScope[] = [
  'filesystem.write',
  'network.private',
  'browser.control',
  'shell.execute',
  'repo.write',
  'deployment.promote',
  'secrets.use',
  'device.control',
];

export const permissionDecisionSchema = z.enum(['ALLOW', 'ASK', 'DENY']);
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;

export const jobStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'waiting_permission',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const structuredFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  at: z.string(),
});
export type StructuredFailure = z.infer<typeof structuredFailureSchema>;

export const jobRecordSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  dungeon: z.string(),
  type: z.string(),
  status: jobStatusSchema,
  priority: z.number().int(),
  currentStage: z.string().nullable(),
  progressRatio: z.number().min(0).max(1),
  checkpoint: z.record(z.string(), z.unknown()),
  retryCount: z.number().int(),
  maxRetries: z.number().int(),
  leaseOwner: z.string().nullable(),
  leaseUntil: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  traceId: z.string(),
  failureReason: structuredFailureSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type JobRecord = z.infer<typeof jobRecordSchema>;

export const manifestEntrySchema = z.object({
  path: z.string(),
  sha256: z.string().length(64),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  executable: z.boolean().default(false),
});
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

export const projectManifestSchema = z.object({
  version: z.literal(1),
  projectId: z.string(),
  manifestHash: z.string().length(64),
  entries: z.array(manifestEntrySchema),
  createdAt: z.string(),
});
export type ProjectManifest = z.infer<typeof projectManifestSchema>;

export const provenanceRecordSchema = z.object({
  artefactId: z.string(),
  projectId: z.string(),
  sourceInputs: z.array(z.string()),
  inputManifestHash: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  toolCalls: z.array(toolCallRequestSchema),
  jobId: z.string().nullable(),
  timestamp: z.string(),
  traceId: z.string(),
});
export type ProvenanceRecord = z.infer<typeof provenanceRecordSchema>;

export const dungeonIdSchema = z.enum([
  'writing',
  'investigation',
  'research',
  'website',
  'osint',
  'music',
]);
export type DungeonId = z.infer<typeof dungeonIdSchema>;

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
  error: structuredFailureSchema.nullable(),
});
export type OsintFinding = z.infer<typeof osintFindingSchema>;

export const bookProjectPartSchema = z.enum([
  'manuscript',
  'chapters',
  'structure',
  'characters',
  'research',
  'continuity',
  'voice',
  'editorial',
  'publishing',
]);
export type BookProjectPart = z.infer<typeof bookProjectPartSchema>;

export const siteConcernSchema = z.enum([
  'working_tree',
  'revision',
  'build_cache',
  'preview_deployment',
  'production_deployment',
  'domain',
  'artefact',
]);
export type SiteConcern = z.infer<typeof siteConcernSchema>;

export const outboxStatusSchema = z.enum(['pending', 'published', 'failed']);
export type OutboxStatus = z.infer<typeof outboxStatusSchema>;

export const outboxRecordSchema = z.object({
  id: z.string(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  eventType: z.string(),
  payload: z.record(z.string(), z.unknown()),
  status: outboxStatusSchema,
  createdAt: z.string(),
  publishedAt: z.string().nullable(),
});
export type OutboxRecord = z.infer<typeof outboxRecordSchema>;
