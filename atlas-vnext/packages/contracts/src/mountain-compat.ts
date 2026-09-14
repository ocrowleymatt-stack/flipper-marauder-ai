import { z } from 'zod';

/**
 * Mountain behavioural compatibility contracts.
 *
 * Provenance of each requirement is labelled **specified** (user-authoritative
 * Mountain semantics; TypeScript Atlas Mountain tree was not inspectable this
 * run) or **inspected** (verified against accessible vNext / Caspa / commons).
 *
 * Architecture remains vNext: Nexus = WHERE, Execution = HOW. These schemas
 * lock *externally meaningful* Mountain behaviour, not Mountain's folder layout.
 */

export const mountainCompatProvenanceSchema = z.enum(['specified', 'inspected']);
export type MountainCompatProvenance = z.infer<typeof mountainCompatProvenanceSchema>;

/** Specified: Standard vs Open response posture. Open must not change Authority. */
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
 * Specified (Mountain PRs #172 / #221, uninspected): Open changes response
 * posture only. These scopes must stay independent of Behaviour.
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

/** Specified: Auto/Power-Pod is specialist/fallback, not a registry alias key. */
export const routingDelegationSchema = z.enum(['auto', 'power_pod']);
export type RoutingDelegation = z.infer<typeof routingDelegationSchema>;

export const retryClassSchema = z.enum(['transient', 'terminal']);
export type RetryClass = z.infer<typeof retryClassSchema>;

/**
 * Specified: timeout/reset/429/5xx are transient; 400/401/unsupported/
 * permission/context overflow are terminal (bounded retry must not continue).
 */
export const classifiedFailureSchema = z.object({
  retryClass: retryClassSchema,
  code: z.string().min(1),
  retryable: z.boolean(),
});
export type ClassifiedFailure = z.infer<typeof classifiedFailureSchema>;

/**
 * Specified: bounded artefact/workspace/release/event retention under disk pressure.
 * Caps are fail-closed defaults, not "keep forever".
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
