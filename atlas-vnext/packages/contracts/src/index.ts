import { z } from 'zod';
import { rejectedCandidateSchema, routingDelegationSchema } from './mountain-compat.ts';
export {
  CAPABILITY_SCOPES,
  capabilityScopeSchema,
  authorityCapabilitySchema,
  DANGEROUS_CAPABILITY_SCOPES,
  READONLY_TOOL_CAPABILITIES,
} from './capabilities.ts';
export type { CapabilityScope, AuthorityCapability } from './capabilities.ts';

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

export const localitySchema = z.enum(['local', 'private_cloud', 'public_cloud']);
export type Locality = z.infer<typeof localitySchema>;

export const runtimeClassSchema = z.enum([
  'always_available',
  'private_hosted',
  'on_demand',
  'expensive_burst',
]);
export type RuntimeClass = z.infer<typeof runtimeClassSchema>;

export const privacyEligibilitySchema = z.enum(['any', 'local_only']);
export type PrivacyEligibility = z.infer<typeof privacyEligibilitySchema>;

export const providerHealthSchema = z.enum([
  'healthy',
  'configured',
  'unhealthy',
  'authentication_failure',
  'unavailable',
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
  runtimeClass: runtimeClassSchema.default('always_available'),
  health: providerHealthSchema.default('configured'),
  privacyEligibility: privacyEligibilitySchema.default('any'),
  runtimeRequirements: z.array(z.string().min(1)).default([]),
  /** Provider API model id when it differs from the registry `model` key. */
  upstreamId: z.string().min(1).optional(),
});
export type RegisteredModel = z.infer<typeof registeredModelSchema>;

export const routeDecisionSchema = z.object({
  target: z.string(),
  resolvedRouteId: z.string(),
  provider: z.string(),
  model: z.string(),
  candidateChain: z.array(z.string()),
  localOnly: z.boolean(),
  locality: localitySchema,
  runtimeClass: runtimeClassSchema,
  decisionReason: z.string(),
  traceId: z.string(),
  evaluatedAt: z.string(),
  /** Ranking rejects (privacy, health, requirements) — not only the winner. */
  rejectedCandidates: z.array(rejectedCandidateSchema).optional(),
  /** How the chain was produced. `auto` / `power_pod` are not alias-table lookups. */
  delegation: routingDelegationSchema.optional(),
});
export type RouteDecision = z.infer<typeof routeDecisionSchema>;

export const toolCallRequestSchema = z.object({
  id: z.string(),
  toolId: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});
export type ToolCallRequest = z.infer<typeof toolCallRequestSchema>;

export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export const streamChunkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), call: toolCallRequestSchema }),
  z.object({ type: z.literal('usage'), usage: tokenUsageSchema }),
  z.object({
    type: z.literal('warning'),
    message: z.string(),
    provider: z.string().optional(),
  }),
]);
export type StreamChunk = z.infer<typeof streamChunkSchema>;

export const permissionDecisionSchema = z.enum(['ALLOW', 'ASK', 'DENY']);
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;

export const jobStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'waiting_runtime',
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
  tenantId: z.string().min(1).optional(),
  workspaceId: z.string().nullable().optional(),
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
  cancelRequested: z.boolean().optional(),
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
  capability: z.string().optional(),
  /** Provider-reported usage only. Never invent token counts. */
  usage: tokenUsageSchema.nullable().optional(),
  locality: localitySchema.optional(),
  latencyMs: z.number().int().nonnegative().nullable().optional(),
  selectedRouteId: z.string().optional(),
  attemptOutcomes: z
    .array(
      z.object({
        provider: z.string().min(1),
        model: z.string().min(1),
        outcome: z.string().min(1),
        emittedVisibleOutput: z.boolean(),
      }),
    )
    .optional(),
});
export type ProvenanceRecord = z.infer<typeof provenanceRecordSchema>;

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

/**
 * Conversation spine contracts.
 *
 * Conversations belong to a workspace (`workspaceId` / `projectId` alias).
 * They are platform/domain state, not UI memory and not Nexus routing policy.
 * Message bodies of conversational scale live in metadata storage.
 * Durable results that are not chat — artefacts, jobs, files — use their own
 * records; CAS remains for blobs. Do not treat messages as the only durable result.
 */
export const conversationSchema = z.object({
  id: z.string().min(1),
  urn: z.string().min(1),
  title: z.string().min(1),
  projectId: z.string().nullable(),
  tenantId: z.string().min(1).optional(),
  workspaceId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const messageRoleSchema = z.enum(['user', 'assistant', 'system']);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const messageSchema = z.object({
  id: z.string().min(1),
  urn: z.string().min(1),
  conversationId: z.string().min(1),
  role: messageRoleSchema,
  content: z.string(),
  sequence: z.number().int().nonnegative(),
  executionId: z.string().nullable(),
  tenantId: z.string().min(1).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Message = z.infer<typeof messageSchema>;

export const executionStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

export const executionAttemptOutcomeSchema = z.enum([
  'started',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
]);
export type ExecutionAttemptOutcome = z.infer<typeof executionAttemptOutcomeSchema>;

export const executionAttemptSchema = z.object({
  index: z.number().int().nonnegative(),
  provider: z.string().min(1),
  model: z.string().min(1),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  outcome: executionAttemptOutcomeSchema,
  error: structuredFailureSchema.nullable(),
  emittedVisibleOutput: z.boolean(),
});
export type ExecutionAttempt = z.infer<typeof executionAttemptSchema>;

export const executionRecordSchema = z.object({
  id: z.string().min(1),
  urn: z.string().min(1),
  conversationId: z.string().min(1),
  userMessageId: z.string().min(1),
  assistantMessageId: z.string().nullable(),
  tenantId: z.string().min(1).optional(),
  status: executionStatusSchema,
  capability: z.string().min(1),
  route: routeDecisionSchema.nullable(),
  selectedProvider: z.string().nullable(),
  selectedModel: z.string().nullable(),
  attempts: z.array(executionAttemptSchema),
  usage: tokenUsageSchema.nullable(),
  failureReason: structuredFailureSchema.nullable(),
  latencyMs: z.number().int().nonnegative().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type ExecutionRecord = z.infer<typeof executionRecordSchema>;

export const conversationEventTypeSchema = z.enum([
  'conversation.created',
  'message.appended',
  'execution.created',
  'execution.started',
  'execution.routed',
  'execution.attempt_started',
  'execution.attempt_failed',
  'execution.attempt_succeeded',
  'execution.attempt_skipped',
  'execution.completed',
  'execution.failed',
  'execution.cancelled',
]);
export type ConversationEventType = z.infer<typeof conversationEventTypeSchema>;

export const conversationStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), message: messageSchema }),
  z.object({
    type: z.literal('message.delta'),
    messageId: z.string(),
    content: z.string(),
  }),
  z.object({ type: z.literal('execution'), execution: executionRecordSchema }),
  z.object({ type: z.literal('error'), failure: structuredFailureSchema }),
  z.object({ type: z.literal('done') }),
  z.object({
    type: z.literal('execution.started'),
    executionId: z.string(),
    capability: z.string(),
  }),
  z.object({
    type: z.literal('attempt.started'),
    executionId: z.string(),
    index: z.number(),
    provider: z.string(),
    model: z.string(),
  }),
  z.object({
    type: z.literal('attempt.completed'),
    executionId: z.string(),
    index: z.number(),
    provider: z.string(),
    model: z.string(),
    outcome: executionAttemptOutcomeSchema,
  }),
  z.object({
    type: z.literal('attempt.failed'),
    executionId: z.string(),
    index: z.number(),
    provider: z.string(),
    model: z.string(),
    failure: structuredFailureSchema,
    emittedVisibleOutput: z.boolean(),
  }),
  z.object({
    type: z.literal('assistant.delta'),
    executionId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('assistant.completed'),
    executionId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('reasoning.delta'),
    executionId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('tool.requested'),
    executionId: z.string(),
    call: toolCallRequestSchema,
  }),
  z.object({
    type: z.literal('tool.lifecycle'),
    executionId: z.string(),
    invocationId: z.string(),
    toolId: z.string(),
    status: z.string().min(1),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool.result'),
    executionId: z.string(),
    invocationId: z.string(),
    toolId: z.string(),
    resultRef: z.string().nullable().optional(),
    output: z.unknown().optional(),
  }),
  z.object({ type: z.literal('usage'), executionId: z.string(), usage: tokenUsageSchema }),
  z.object({
    type: z.literal('provider.warning'),
    executionId: z.string(),
    provider: z.string(),
    message: z.string(),
  }),
  z.object({
    type: z.literal('provider.failed'),
    executionId: z.string(),
    provider: z.string(),
    model: z.string(),
    failure: structuredFailureSchema,
  }),
  z.object({
    type: z.literal('execution.completed'),
    executionId: z.string(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
  }),
  z.object({
    type: z.literal('execution.failed'),
    executionId: z.string(),
    failure: structuredFailureSchema,
  }),
]);
export type ConversationStreamEvent = z.infer<typeof conversationStreamEventSchema>;

export const conversationSnapshotSchema = z.object({
  conversation: conversationSchema,
  messages: z.array(messageSchema),
  executions: z.array(executionRecordSchema),
});
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;

export * from './dungeon-ids.ts';
export * from './mountain-compat.ts';
export * from './tools-auth.ts';
export * from './writing.ts';
export * from './privacy.ts';
export * from './estate.ts';
export * from './compiled-context.ts';
export * from './slow-cook.ts';
export * from './operations.ts';
export * from './evidence.ts';
export * from './investigation-analysis.ts';
export * from './acquisition.ts';
export * from './search.ts';
