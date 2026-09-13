/** Design-gate contracts only. There is intentionally no runtime implementation. */

export type Id = string;
export type IsoDateTime = string;

export interface Provenance {
  producer: { kind: 'provider' | 'tool' | 'job' | 'plugin' | 'user'; id: Id; version?: string };
  sources: Array<{ uri: string; retrievedAt?: IsoDateTime; contentHash?: string }>;
  createdAt: IsoDateTime;
  correlationId: Id;
  derivationIds: Id[];
  evidenceStatus: 'observed' | 'reported' | 'inferred' | 'generated' | 'unverified';
}

export interface Project {
  projectId: Id;
  tenantId: Id;
  name: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  version: number;
}

export type JobState =
  | 'queued'
  | 'leased'
  | 'running'
  | 'suspended'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface DurableJob<TInput = unknown> {
  jobId: Id;
  idempotencyKey: string;
  jobType: string;
  handlerVersion: string;
  tenantId: Id;
  projectId: Id;
  correlationId: Id;
  requestedBy: Id;
  requiredCapabilities: string[];
  state: JobState;
  input: TInput;
  attempt: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  lease?: { owner: string; expiresAt: IsoDateTime; heartbeatAt: IsoDateTime };
  suspension?: { kind: 'permission' | 'input'; requestId: Id; since: IsoDateTime };
}

export type AtlasEventType =
  | 'job.state.changed'
  | 'job.progress'
  | 'permission.requested'
  | 'permission.decided'
  | 'artifact.published'
  | 'tool.completed';

export interface EventEnvelope<TPayload = unknown> {
  eventId: Id;
  eventType: AtlasEventType;
  occurredAt: IsoDateTime;
  tenantId: Id;
  projectId: Id;
  correlationId: Id;
  jobId?: Id;
  sequence?: number;
  producer: { id: Id; version: string };
  payload: TPayload;
  provenance?: Provenance;
}

export interface ContentRef {
  algorithm: 'sha256';
  digest: string;
  size: number;
  mediaType: string;
  provenance: Provenance;
}

export interface CapabilityGrant {
  grantId: Id;
  principalId: Id;
  tenantId: Id;
  capabilities: string[];
  constraints: Record<string, unknown>;
  issuedAt: IsoDateTime;
  expiresAt?: IsoDateTime;
}

export interface ExecutionIntent {
  intentId: Id;
  correlationId: Id;
  tenantId: Id;
  projectId: Id;
  capability: string;
  orderedProviderIds: string[];
  requiredCapabilities: string[];
  budgets: { maxInputTokens: number; maxOutputTokens: number; deadlineMs: number };
  registryVersion: number;
}
