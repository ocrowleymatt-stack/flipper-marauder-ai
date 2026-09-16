import { z } from 'zod';
import { dungeonIdSchema } from './dungeon-ids.ts';

export const processingLocalitySchema = z.enum(['any', 'local_only', 'private_cloud']);
export type ProcessingLocality = z.infer<typeof processingLocalitySchema>;

export const retrievalScopeSchema = z.enum(['none', 'selected_files', 'project']);
export type RetrievalScope = z.infer<typeof retrievalScopeSchema>;

export const networkAccessSchema = z.enum(['none', 'public', 'private']);
export type NetworkAccess = z.infer<typeof networkAccessSchema>;

export const tenantSharingSchema = z.enum(['none', 'workspace', 'tenant']);
export type TenantSharing = z.infer<typeof tenantSharingSchema>;

export const telemetryModeSchema = z.enum(['off', 'minimal', 'standard']);
export type TelemetryMode = z.infer<typeof telemetryModeSchema>;

export const secretsExposureSchema = z.enum(['none', 'named']);
export type SecretsExposure = z.infer<typeof secretsExposureSchema>;

export const sensitiveDataModeSchema = z.enum(['block', 'redact', 'allow_local']);
export type SensitiveDataMode = z.infer<typeof sensitiveDataModeSchema>;

export const autonomyCeilingSchema = z.enum(['suggest', 'assist', 'act_with_approval', 'act']);
export type AutonomyCeiling = z.infer<typeof autonomyCeilingSchema>;

export const sandboxingModeSchema = z.enum(['strict', 'standard']);
export type SandboxingMode = z.infer<typeof sandboxingModeSchema>;

export const effectivePolicySchema = z.object({
  tenantId: z.string().min(1),
  dungeonId: dungeonIdSchema.nullable(),
  modelProvidersAllowed: z.array(z.string().min(1)),
  modelProvidersDenied: z.array(z.string().min(1)),
  processing: processingLocalitySchema,
  retentionDays: z.number().int().positive().nullable(),
  memoryEnabled: z.boolean(),
  projectFileAccess: retrievalScopeSchema,
  retrievalScope: retrievalScopeSchema,
  toolsEnabled: z.boolean(),
  pluginsEnabled: z.boolean(),
  networkAccess: networkAccessSchema,
  repoWrite: z.boolean(),
  tenantSharing: tenantSharingSchema,
  telemetry: telemetryModeSchema,
  secretsExposure: secretsExposureSchema,
  sensitiveData: sensitiveDataModeSchema,
  autonomyCeiling: autonomyCeilingSchema,
  approvalRequired: z.array(z.string().min(1)),
  sandboxing: sandboxingModeSchema,
  childProcesses: z.boolean(),
  revision: z.number().int().positive(),
  updatedAt: z.string(),
  updatedBy: z.string().min(1),
});
export type EffectivePolicy = z.infer<typeof effectivePolicySchema>;

/** What a model may see. Never includes secrets, other-tenant data, or privileged audit internals. */
export const modelPolicyContextSchema = z.object({
  dungeonId: dungeonIdSchema.nullable(),
  processing: processingLocalitySchema,
  retrievalScope: retrievalScopeSchema,
  toolsEnabled: z.boolean(),
  networkAccess: networkAccessSchema,
  autonomyCeiling: autonomyCeilingSchema,
  approvalRequired: z.array(z.string().min(1)),
  localOnly: z.boolean(),
});
export type ModelPolicyContext = z.infer<typeof modelPolicyContextSchema>;

export const policyExplanationSchema = z.object({
  action: z.string().min(1),
  allowed: z.boolean(),
  reasonCode: z.string().min(1),
  authorityRule: z.string().min(1),
  policyRule: z.string().min(1),
  modelAccess: z.array(z.string().min(1)),
  canLeaveEnvironment: z.array(z.string().min(1)),
  canExecuteWithoutApproval: z.array(z.string().min(1)),
});
export type PolicyExplanation = z.infer<typeof policyExplanationSchema>;

export const privacyAuditEntrySchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  actorId: z.string().min(1),
  action: z.string().min(1),
  capability: z.string().min(1),
  resource: z.string().nullable(),
  decision: z.enum(['ALLOW', 'DENY', 'ASK']),
  reasonCode: z.string().min(1),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  stepUp: z.boolean(),
  at: z.string(),
});
export type PrivacyAuditEntry = z.infer<typeof privacyAuditEntrySchema>;

export const privacyProposalSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  proposedBy: z.string().min(1),
  dungeonId: dungeonIdSchema.nullable(),
  patch: z.record(z.string(), z.unknown()),
  status: z.enum(['proposed', 'approved', 'denied']),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type PrivacyProposal = z.infer<typeof privacyProposalSchema>;

export const CONSEQUENTIAL_POLICY_FIELDS = [
  'processing',
  'networkAccess',
  'repoWrite',
  'secretsExposure',
  'autonomyCeiling',
  'childProcesses',
  'sandboxing',
  'modelProvidersAllowed',
  'modelProvidersDenied',
  'approvalRequired',
] as const;

export function defaultEffectivePolicy(tenantId: string, dungeonId: EffectivePolicy['dungeonId'] = null): Omit<
  EffectivePolicy,
  'revision' | 'updatedAt' | 'updatedBy'
> {
  return {
    tenantId,
    dungeonId,
    modelProvidersAllowed: [],
    modelProvidersDenied: [],
    processing: 'any',
    retentionDays: null,
    memoryEnabled: true,
    projectFileAccess: 'selected_files',
    retrievalScope: 'selected_files',
    toolsEnabled: true,
    pluginsEnabled: true,
    networkAccess: 'public',
    repoWrite: false,
    tenantSharing: 'none',
    telemetry: 'minimal',
    secretsExposure: 'none',
    sensitiveData: 'redact',
    autonomyCeiling: 'act_with_approval',
    approvalRequired: ['tool.invoke.external_write', 'repo.write', 'deployment.promote', 'publish.external'],
    sandboxing: 'strict',
    childProcesses: false,
  };
}

export function toModelPolicyContext(policy: EffectivePolicy): ModelPolicyContext {
  return {
    dungeonId: policy.dungeonId,
    processing: policy.processing,
    retrievalScope: policy.retrievalScope,
    toolsEnabled: policy.toolsEnabled,
    networkAccess: policy.networkAccess,
    autonomyCeiling: policy.autonomyCeiling,
    approvalRequired: [...policy.approvalRequired],
    localOnly: policy.processing === 'local_only',
  };
}
