import type {
  Conversation,
  ExecutionAttempt,
  ExecutionRecord,
  Message,
  ProvenanceRecord,
  RouteDecision,
  StructuredFailure,
  TokenUsage,
} from '@atlas-vnext/contracts';
import type { DomainEvent } from '@atlas-vnext/events';
import type { JobRecord } from '@atlas-vnext/contracts';
import type { ArtefactMetadata, PrincipalRecord, RuntimeLeaseRecord, TenantRecord, WorkspaceRecord } from '../kernel.ts';

export function sqlRow<T>(row: object): T {
  return row as T;
}

export function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function isoRequired(value: Date | string): string {
  return iso(value) ?? new Date().toISOString();
}

export function asJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    urn: row.urn,
    title: row.title,
    // Alias until first-class Project objects exist. Workspaces are the durable container.
    projectId: row.workspace_id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
  };
}

export function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    urn: row.urn,
    conversationId: row.conversation_id,
    role: row.role as Message['role'],
    content: row.content,
    sequence: Number(row.sequence),
    executionId: row.execution_id,
    tenantId: row.tenant_id,
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
  };
}

export function mapExecution(row: ExecutionRow): ExecutionRecord {
  return {
    id: row.id,
    urn: row.urn,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    tenantId: row.tenant_id,
    status: row.status as ExecutionRecord['status'],
    capability: row.capability,
    route: asJson<RouteDecision | null>(row.route, null),
    selectedProvider: row.selected_provider,
    selectedModel: row.selected_model,
    attempts: asJson<ExecutionAttempt[]>(row.attempts, []),
    usage: asJson<TokenUsage | null>(row.usage, null),
    failureReason: asJson<StructuredFailure | null>(row.failure_reason, null),
    latencyMs: row.latency_ms,
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  };
}

export function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    dungeon: row.dungeon,
    type: row.type,
    status: row.status as JobRecord['status'],
    priority: Number(row.priority),
    currentStage: row.current_stage,
    progressRatio: Number(row.progress_ratio),
    checkpoint: asJson<Record<string, unknown>>(row.checkpoint, {}),
    retryCount: Number(row.retry_count),
    maxRetries: Number(row.max_retries),
    leaseOwner: row.lease_owner,
    leaseUntil: iso(row.lease_until),
    idempotencyKey: row.idempotency_key,
    cancelRequested: Boolean(row.cancel_requested),
    traceId: row.trace_id,
    failureReason: asJson<StructuredFailure | null>(row.failure_reason, null),
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  };
}

export function mapEvent(row: EventRow): DomainEvent {
  return {
    eventId: row.id,
    channel: row.stream_id,
    type: row.type,
    timestamp: isoRequired(row.created_at),
    payload: asJson(row.payload, {}),
    seq: Number(row.seq),
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    jobId: row.job_id,
    idempotencyKey: row.idempotency_key,
  };
}

export function mapTenant(row: { id: string; urn: string; name: string; created_at: Date | string; updated_at: Date | string }): TenantRecord {
  return {
    id: row.id,
    urn: row.urn,
    name: row.name,
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
  };
}

export function mapPrincipal(row: {
  id: string;
  urn: string;
  display_name: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): PrincipalRecord {
  return {
    id: row.id,
    urn: row.urn,
    displayName: row.display_name,
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
  };
}

export function mapWorkspace(row: {
  id: string;
  urn: string;
  tenant_id: string;
  name: string;
  description?: string | null;
  dungeon: string | null;
  root_manifest_hash: string | null;
  archived: boolean;
  revision?: number | string | null;
  deleted_at?: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): WorkspaceRecord {
  return {
    id: row.id,
    urn: row.urn,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description ?? null,
    dungeon: row.dungeon,
    rootManifestHash: row.root_manifest_hash,
    archived: Boolean(row.archived),
    revision: row.revision == null ? 1 : Number(row.revision),
    deletedAt: row.deleted_at ? isoRequired(row.deleted_at) : null,
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
  };
}

export function mapLease(row: {
  id: string;
  tenant_id: string;
  resource_key: string;
  owner: string | null;
  lease_until: Date | string | null;
  status: string;
  metadata: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}): RuntimeLeaseRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    resourceKey: row.resource_key,
    owner: row.owner,
    leaseUntil: iso(row.lease_until),
    status: row.status,
    metadata: asJson(row.metadata, {}),
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
  };
}

export function mapArtefact(row: {
  id: string;
  urn?: string | null;
  tenant_id: string;
  workspace_id: string | null;
  type?: string | null;
  version?: number | string | null;
  parent_id?: string | null;
  created_by?: string | null;
  execution_id?: string | null;
  job_id?: string | null;
  content_hash: string | null;
  mime_type: string | null;
  size_bytes: string | number | null;
  created_at: Date | string;
  updated_at?: Date | string | null;
}): ArtefactMetadata {
  return {
    id: row.id,
    urn: row.urn ?? `urn:atlas:artefact:${row.id}`,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    type: row.type ?? null,
    version: row.version == null ? 1 : Number(row.version),
    parentId: row.parent_id ?? null,
    createdBy: row.created_by ?? null,
    executionId: row.execution_id ?? null,
    jobId: row.job_id ?? null,
    contentHash: row.content_hash,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at ?? row.created_at),
  };
}

export function mapProvenance(row: {
  artefact_id: string;
  project_id: string;
  source_inputs: unknown;
  input_manifest_hash: string | null;
  provider: string;
  model: string;
  tool_calls: unknown;
  job_id: string | null;
  timestamp: Date | string;
  trace_id: string;
  capability: string | null;
  usage: unknown;
  locality: string | null;
  latency_ms: number | null;
  selected_route_id: string | null;
  attempt_outcomes: unknown;
}): ProvenanceRecord {
  return {
    artefactId: row.artefact_id,
    projectId: row.project_id,
    sourceInputs: asJson(row.source_inputs, []),
    inputManifestHash: row.input_manifest_hash,
    provider: row.provider,
    model: row.model,
    toolCalls: asJson(row.tool_calls, []),
    jobId: row.job_id,
    timestamp: isoRequired(row.timestamp),
    traceId: row.trace_id,
    capability: row.capability ?? undefined,
    usage: asJson(row.usage, null),
    locality: (row.locality as ProvenanceRecord['locality']) ?? undefined,
    latencyMs: row.latency_ms,
    selectedRouteId: row.selected_route_id ?? undefined,
    attemptOutcomes: asJson(row.attempt_outcomes, undefined),
  };
}

export interface ConversationRow {
  id: string;
  urn: string;
  tenant_id: string;
  workspace_id: string | null;
  title: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface MessageRow {
  id: string;
  urn: string;
  tenant_id: string;
  conversation_id: string;
  role: string;
  content: string;
  sequence: number;
  execution_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ExecutionRow {
  id: string;
  urn: string;
  tenant_id: string;
  conversation_id: string;
  user_message_id: string;
  assistant_message_id: string | null;
  status: string;
  capability: string;
  route: unknown;
  selected_provider: string | null;
  selected_model: string | null;
  attempts: unknown;
  usage: unknown;
  failure_reason: unknown;
  latency_ms: number | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
}

export interface JobRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  project_id: string | null;
  dungeon: string;
  type: string;
  status: string;
  priority: number;
  current_stage: string | null;
  progress_ratio: number;
  checkpoint: unknown;
  retry_count: number;
  max_retries: number;
  lease_owner: string | null;
  lease_until: Date | string | null;
  idempotency_key: string | null;
  cancel_requested: boolean;
  trace_id: string;
  failure_reason: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
}

export interface EventRow {
  id: string;
  stream_id: string;
  seq: string | number;
  type: string;
  payload: unknown;
  tenant_id: string;
  workspace_id: string | null;
  conversation_id: string | null;
  job_id: string | null;
  idempotency_key: string | null;
  created_at: Date | string;
}
