import { z } from 'zod';
import { authorityCapabilitySchema } from './capabilities.ts';

const structuredFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  at: z.string(),
});

export const principalKindSchema = z.enum(['user', 'guest', 'system']);
export type PrincipalKind = z.infer<typeof principalKindSchema>;

export const principalSchema = z.object({
  id: z.string().min(1),
  urn: z.string().min(1),
  kind: principalKindSchema,
  displayName: z.string().nullable().optional(),
  tenantId: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable().optional(),
});
export type Principal = z.infer<typeof principalSchema>;

export const SYSTEM_PRINCIPAL_ID = 'principal_system';
export const GUEST_PRINCIPAL_ID = 'principal_guest';

export const tenantMembershipSchema = z.object({
  principalId: z.string().min(1),
  tenantId: z.string().min(1),
  role: z.string().min(1),
  capabilities: z.array(authorityCapabilitySchema).default([]),
  createdAt: z.string(),
});
export type TenantMembership = z.infer<typeof tenantMembershipSchema>;

export const workspaceMembershipSchema = z.object({
  principalId: z.string().min(1),
  tenantId: z.string().min(1),
  workspaceId: z.string().min(1),
  role: z.string().min(1),
  capabilities: z.array(authorityCapabilitySchema).default([]),
  createdAt: z.string(),
});
export type WorkspaceMembership = z.infer<typeof workspaceMembershipSchema>;

export const sessionRecordSchema = z.object({
  id: z.string().min(1),
  principalId: z.string().min(1),
  tenantId: z.string().min(1).nullable(),
  csrfSecret: z.string().min(1),
  createdAt: z.string(),
  expiresAt: z.string(),
  rotatedAt: z.string().nullable().optional(),
  revokedAt: z.string().nullable(),
  lastSeenAt: z.string(),
  userAgentHash: z.string().nullable().optional(),
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

export const resourceTypeSchema = z.enum([
  'tenant',
  'workspace',
  'conversation',
  'project',
  'file',
  'artifact',
  'tool',
  'plugin',
  'job',
  'invocation',
  'secret',
]);
export type ResourceType = z.infer<typeof resourceTypeSchema>;

export const authorityResourceSchema = z.object({
  type: resourceTypeSchema,
  id: z.string().min(1).optional(),
  tenantId: z.string().min(1),
  workspaceId: z.string().min(1).nullable().optional(),
});
export type AuthorityResource = z.infer<typeof authorityResourceSchema>;

export const authorityDecisionSchema = z.enum(['ALLOW', 'ASK', 'DENY']);
export type AuthorityDecisionKind = z.infer<typeof authorityDecisionSchema>;

export const authorityDenialCodeSchema = z.enum([
  'unauthenticated',
  'not_a_member',
  'capability_missing',
  'resource_out_of_scope',
  'behaviour_not_authority',
  'plugin_cannot_bypass',
  'invalid_capability',
  'cross_tenant',
  'session_revoked',
  'fail_closed',
]);
export type AuthorityDenialCode = z.infer<typeof authorityDenialCodeSchema>;

export const authorityVerdictSchema = z.object({
  decision: authorityDecisionSchema,
  capability: z.string().min(1),
  reasonCode: authorityDenialCodeSchema.optional(),
  message: z.string().min(1),
  leakSensitive: z.boolean().default(false),
});
export type AuthorityVerdict = z.infer<typeof authorityVerdictSchema>;

export const toolCategorySchema = z.enum([
  'retrieval_readonly',
  'fs_read',
  'fs_write',
  'browser_nav_read',
  'browser_state_changing',
  'external_api_read',
  'external_api_mutation',
  'shell_process',
  'code_exec',
  'long_running_job',
  'project_file_artifact',
  'communication_publish',
  'admin',
]);
export type ToolCategory = z.infer<typeof toolCategorySchema>;

export const sideEffectClassSchema = z.enum(['none', 'idempotent', 'uncertain_external']);
export type SideEffectClass = z.infer<typeof sideEffectClassSchema>;

export const approvalPolicySchema = z.enum(['none', 'required', 'required_if_external']);
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

export const toolIdempotencyModeSchema = z.enum(['none', 'keyed', 'always']);
export type ToolIdempotencyMode = z.infer<typeof toolIdempotencyModeSchema>;

export const jsonSchemaObjectSchema: z.ZodType<Record<string, unknown>> = z.record(z.string(), z.unknown());

export const toolDefinitionSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  category: toolCategorySchema,
  inputSchema: jsonSchemaObjectSchema,
  outputSchema: jsonSchemaObjectSchema,
  requiredCapabilities: z.array(authorityCapabilitySchema).min(1),
  sideEffectClass: sideEffectClassSchema,
  idempotency: toolIdempotencyModeSchema,
  approvalPolicy: approvalPolicySchema,
  timeoutMs: z.number().int().positive(),
  cancelSupported: z.boolean(),
  pluginId: z.string().min(1).nullable().optional(),
  adapter: z.string().min(1),
});
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;

export const toolInvocationStatusSchema = z.enum([
  'proposed',
  'validated',
  'authorised',
  'awaiting_approval',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'denied',
  'uncertain',
]);
export type ToolInvocationStatus = z.infer<typeof toolInvocationStatusSchema>;

export const toolInvocationSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  workspaceId: z.string().min(1).nullable(),
  principalId: z.string().min(1),
  conversationId: z.string().min(1).nullable().optional(),
  executionId: z.string().min(1).nullable().optional(),
  jobId: z.string().min(1).nullable().optional(),
  pluginId: z.string().min(1).nullable().optional(),
  toolId: z.string().min(1),
  toolVersion: z.string().min(1),
  status: toolInvocationStatusSchema,
  arguments: z.record(z.string(), z.unknown()),
  argumentHash: z.string().length(64),
  idempotencyKey: z.string().min(1).nullable(),
  attemptId: z.string().min(1).nullable(),
  attemptCount: z.number().int().nonnegative(),
  approvalId: z.string().min(1).nullable().optional(),
  resultRef: z.string().min(1).nullable().optional(),
  artefactIds: z.array(z.string().min(1)).default([]),
  fileIds: z.array(z.string().min(1)).default([]),
  externalIds: z.array(z.string().min(1)).default([]),
  failureReason: structuredFailureSchema.nullable(),
  cancelRequested: z.boolean().default(false),
  cancelConfirmed: z.boolean().default(false),
  sideEffectClass: sideEffectClassSchema,
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type ToolInvocation = z.infer<typeof toolInvocationSchema>;

export const toolApprovalDecisionSchema = z.enum(['pending', 'approved', 'denied']);
export type ToolApprovalDecision = z.infer<typeof toolApprovalDecisionSchema>;

export const toolApprovalSchema = z.object({
  id: z.string().min(1),
  invocationId: z.string().min(1),
  tenantId: z.string().min(1),
  decidedBy: z.string().min(1),
  decision: toolApprovalDecisionSchema,
  reason: z.string().nullable().optional(),
  expiresAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  nonceHash: z.string().min(1),
});
export type ToolApproval = z.infer<typeof toolApprovalSchema>;

export const pluginStatusSchema = z.enum(['enabled', 'disabled', 'unknown', 'unhealthy']);
export type PluginStatus = z.infer<typeof pluginStatusSchema>;

export const pluginRecordSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  title: z.string().min(1),
  status: pluginStatusSchema,
  toolIds: z.array(z.string().min(1)),
  requiredCapabilities: z.array(authorityCapabilitySchema).default([]),
  secretNames: z.array(z.string().min(1)).default([]),
  rateLimitPerMinute: z.number().int().positive().nullable().optional(),
  externalBinding: z.string().nullable().optional(),
});
export type PluginRecord = z.infer<typeof pluginRecordSchema>;

export const healthComponentSchema = z.enum(['ok', 'error', 'not_configured', 'degraded']);
export type HealthComponent = z.infer<typeof healthComponentSchema>;

export const dependencyHealthSchema = z.object({
  postgres: healthComponentSchema,
  cas: healthComponentSchema,
  jobs: healthComponentSchema,
  runtimeScheduler: healthComponentSchema,
});
export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;

export const operationalLimitsSchema = z.object({
  maxRequestBytes: z.number().int().positive(),
  maxUploadBytes: z.number().int().positive(),
  maxConcurrentExecutions: z.number().int().positive(),
  maxToolConcurrency: z.number().int().positive(),
  perTenantToolInvocationsPerMinute: z.number().int().positive(),
  maxContextTokens: z.number().int().positive(),
  jobQueueMax: z.number().int().positive(),
  defaultToolTimeoutMs: z.number().int().positive(),
  shellTimeoutMs: z.number().int().positive(),
  codeTimeoutMs: z.number().int().positive(),
  maxShellOutputBytes: z.number().int().positive(),
  maxCodeOutputBytes: z.number().int().positive(),
  sessionTtlMs: z.number().int().positive(),
  approvalTtlMs: z.number().int().positive(),
  maxContextFiles: z.number().int().positive(),
  maxRetrievalChunks: z.number().int().positive(),
  maxGeneratedBytes: z.number().int().positive(),
  maxToolArgBytes: z.number().int().positive(),
  maxConcurrentStreams: z.number().int().positive(),
  maxPendingApprovals: z.number().int().positive(),
  maxConcurrentRuns: z.number().int().positive(),
});
export type OperationalLimits = z.infer<typeof operationalLimitsSchema>;

export const DEFAULT_OPERATIONAL_LIMITS: OperationalLimits = {
  maxRequestBytes: 1_048_576,
  maxUploadBytes: 32 * 1024 * 1024,
  maxConcurrentExecutions: 32,
  maxToolConcurrency: 8,
  perTenantToolInvocationsPerMinute: 120,
  maxContextTokens: 128_000,
  jobQueueMax: 10_000,
  defaultToolTimeoutMs: 30_000,
  shellTimeoutMs: 10_000,
  codeTimeoutMs: 5_000,
  maxShellOutputBytes: 64 * 1024,
  maxCodeOutputBytes: 64 * 1024,
  sessionTtlMs: 12 * 60 * 60 * 1000,
  approvalTtlMs: 24 * 60 * 60 * 1000,
  maxContextFiles: 32,
  maxRetrievalChunks: 64,
  maxGeneratedBytes: 2_000_000,
  maxToolArgBytes: 64 * 1024,
  maxConcurrentStreams: 32,
  maxPendingApprovals: 50,
  maxConcurrentRuns: 16,
};

export const toolProvenanceSchema = z.object({
  tenantId: z.string().min(1),
  principalId: z.string().min(1),
  workspaceId: z.string().nullable(),
  conversationId: z.string().nullable().optional(),
  executionId: z.string().nullable().optional(),
  modelProvider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  toolId: z.string().min(1),
  toolVersion: z.string().min(1),
  argumentHash: z.string().length(64),
  approvalId: z.string().nullable().optional(),
  resultRef: z.string().nullable().optional(),
  artefactIds: z.array(z.string()).default([]),
  outcome: toolInvocationStatusSchema,
  externalIds: z.array(z.string()).default([]),
  attemptCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  completedAt: z.string().nullable().optional(),
});
export type ToolProvenance = z.infer<typeof toolProvenanceSchema>;
