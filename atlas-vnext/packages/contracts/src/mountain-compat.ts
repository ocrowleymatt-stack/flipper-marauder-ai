import { z } from 'zod';

/**
 * Mountain behavioural compatibility contracts.
 *
 * Provenance labels (see atlas-vnext/docs/MOUNTAIN-COMPAT.md):
 * verified_historical — quoted from ocrowleymatt-stack/atlas-mountain @ 5cc7a96
 * user_requirement — required for vNext; not quoted from Mountain this run
 * inspected_vnext — verified against this tree / Caspa / commons
 *
 * Current Mountain main / issue #172 / PR #221 were not readable this run
 * (GitHub App installation is scoped to flipper-marauder-ai only).
 *
 * Architecture remains vNext: Nexus = WHERE, Execution = HOW. These schemas
 * lock *externally meaningful* behaviour, not Mountain's folder layout.
 */

export const mountainCompatProvenanceSchema = z.enum([
  'verified_historical',
  'user_requirement',
  'inspected_vnext',
]);
export type MountainCompatProvenance = z.infer<typeof mountainCompatProvenanceSchema>;

/** User requirement + historical Mountain `behaviour/` vs `permissions/` split. Open must not change Authority. */
export const behaviourModeSchema = z.enum(['standard', 'open']);
export type BehaviourMode = z.infer<typeof behaviourModeSchema>;

/** Fail-closed default when a tenant has no persisted Behaviour row. */
export const DEFAULT_BEHAVIOUR_MODE: BehaviourMode = 'standard';

export const tenantBehaviourRecordSchema = z.object({
  tenantId: z.string().min(1),
  behaviour: behaviourModeSchema,
  updatedAt: z.string(),
  updatedByTenantId: z.string().min(1),
});
export type TenantBehaviourRecord = z.infer<typeof tenantBehaviourRecordSchema>;

/**
 * User requirement (issue #172 / PR #221 not readable this run). Historical
 * Mountain kept `behaviour/` separate from `permissions/` (5cc7a96). Open
 * changes response posture only; these scopes stay independent of Behaviour.
 */
export const AUTHORITY_SCOPES_UNCHANGED_BY_BEHAVIOUR = [
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
  'compute.allocate',
  'admin.configure',
] as const;

export const behaviourAuthorityBoundarySchema = z.object({
  behaviour: behaviourModeSchema,
  grantedScopes: z.array(z.string().min(1)),
  deniedScopes: z.array(z.string().min(1)),
});
export type BehaviourAuthorityBoundary = z.infer<typeof behaviourAuthorityBoundarySchema>;

export const promptLayerSchema = z.object({
  capabilityPolicy: z.string().min(1),
  runtimePolicy: z.string().min(1),
  behaviourPosture: z.string().min(1),
});
export type PromptLayer = z.infer<typeof promptLayerSchema>;

export const composedPromptSchema = z.object({
  layers: promptLayerSchema,
  text: z.string().min(1),
});
export type ComposedPrompt = z.infer<typeof composedPromptSchema>;

/** Inspected: ranking rejects belong on the RouteDecision, not only the winner. */
export const rejectedCandidateSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reason: z.string().min(1),
});
export type RejectedCandidate = z.infer<typeof rejectedCandidateSchema>;

export const routeAttemptOutcomeSchema = z.enum([
  'started',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
  'rejected',
]);
export type RouteAttemptOutcome = z.infer<typeof routeAttemptOutcomeSchema>;

export const observedRouteAttemptSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  outcome: routeAttemptOutcomeSchema,
  reason: z.string().optional(),
  emittedVisibleOutput: z.boolean().optional(),
});
export type ObservedRouteAttempt = z.infer<typeof observedRouteAttemptSchema>;

/** Historical Mountain hybrid-auto-policy / Power-Pod-first; vNext ranking, not an alias key. */
export const routingDelegationSchema = z.enum(['auto', 'power_pod']);
export type RoutingDelegation = z.infer<typeof routingDelegationSchema>;

export const retryClassSchema = z.enum(['transient', 'terminal']);
export type RetryClass = z.infer<typeof retryClassSchema>;

/**
 * Historical Mountain provider-error taxonomy (timeout/unavailable/abrupt_end
 * vs invalid_request/context_length/cancelled) plus vNext HTTP 429/5xx mapping.
 * Bounded retry must not continue for terminal classes.
 */
export const classifiedFailureSchema = z.object({
  retryClass: retryClassSchema,
  code: z.string().min(1),
  retryable: z.boolean(),
});
export type ClassifiedFailure = z.infer<typeof classifiedFailureSchema>;

/**
 * User-requirement caps inspired by historical Mountain storage-pressure
 * recovery (census §9, 5cc7a96). Caps are fail-closed defaults, not "keep forever".
 */
export const retentionBoundsSchema = z.object({
  maxArtefacts: z.number().int().positive(),
  maxWorkspaces: z.number().int().positive(),
  maxReleases: z.number().int().positive(),
  maxEventLogEntries: z.number().int().positive(),
  maxWorkspaceBytes: z.number().int().positive(),
});
export type RetentionBounds = z.infer<typeof retentionBoundsSchema>;

export const DEFAULT_RETENTION_BOUNDS: RetentionBounds = {
  maxArtefacts: 10_000,
  maxWorkspaces: 256,
  maxReleases: 32,
  maxEventLogEntries: 10_000,
  maxWorkspaceBytes: 2 * 1024 * 1024 * 1024,
};

export const MAX_ATTEMPTS_PER_CANDIDATE = 5;
export const DEFAULT_ATTEMPTS_PER_CANDIDATE = 2;
