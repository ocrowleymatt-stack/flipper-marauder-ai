import type {
  Conversation,
  ExecutionRecord,
  Message,
  ProvenanceRecord,
  TenantBehaviourRecord,
  BehaviourMode,
} from '@atlas-vnext/contracts';
import type {
  ConversationRepository,
  ExecutionRepository,
  MessageRepository,
  ProvenanceWriter,
  UnitOfWork,
} from '@atlas-vnext/conversation';
import type { EventBus } from '@atlas-vnext/events';
import type { DurableJobEngine } from '@atlas-vnext/jobs';
import type { PersistenceActor } from './actor.ts';
import type { PersistenceMode } from './config.ts';

export interface TenantRecord {
  id: string;
  urn: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface PrincipalRecord {
  id: string;
  urn: string;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Durable workspace container. First-class named Project objects come later; conversations are one child, not the only one. */
export interface WorkspaceRecord {
  id: string;
  urn: string;
  tenantId: string;
  name: string;
  dungeon: string | null;
  rootManifestHash: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeLeaseRecord {
  id: string;
  tenantId: string;
  resourceKey: string;
  owner: string | null;
  leaseUntil: string | null;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * First-class durable result metadata (not a chat message).
 * Version/parent lineage is here; blob bytes are not (future CAS via contentHash).
 */
export interface ArtefactMetadata {
  id: string;
  urn: string;
  tenantId: string;
  workspaceId: string | null;
  type: string | null;
  version: number;
  parentId: string | null;
  createdBy: string | null;
  executionId: string | null;
  jobId: string | null;
  contentHash: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface DurableBehaviourStore {
  resolve(actorTenantId: string, subjectTenantId?: string): Promise<BehaviourMode>;
  read(actorTenantId: string, subjectTenantId: string): Promise<TenantBehaviourRecord | null>;
  write(
    actorTenantId: string,
    subjectTenantId: string,
    behaviour: BehaviourMode,
  ): Promise<TenantBehaviourRecord>;
}

export interface WorkspaceStore {
  create(actor: PersistenceActor, input: { name: string; dungeon?: string; id?: string }): Promise<WorkspaceRecord>;
  get(actor: PersistenceActor, id: string): Promise<WorkspaceRecord | null>;
  list(actor: PersistenceActor): Promise<WorkspaceRecord[]>;
  bindManifest(actor: PersistenceActor, id: string, manifestHash: string): Promise<WorkspaceRecord>;
}

export interface RuntimeLeaseStore {
  upsert(actor: PersistenceActor, input: Omit<RuntimeLeaseRecord, 'createdAt' | 'updatedAt' | 'tenantId'> & { tenantId?: string }): Promise<RuntimeLeaseRecord>;
  get(actor: PersistenceActor, resourceKey: string): Promise<RuntimeLeaseRecord | null>;
  expire(now?: string): Promise<RuntimeLeaseRecord[]>;
}

export interface ArtefactMetadataStore {
  record(
    actor: PersistenceActor,
    input: Omit<
      ArtefactMetadata,
      'tenantId' | 'urn' | 'createdAt' | 'updatedAt' | 'type' | 'version' | 'parentId' | 'createdBy' | 'executionId' | 'jobId'
    > & {
      createdAt?: string;
      urn?: string;
      type?: string | null;
      version?: number;
      parentId?: string | null;
      createdBy?: string | null;
      executionId?: string | null;
      jobId?: string | null;
    },
  ): Promise<ArtefactMetadata>;
  get(actor: PersistenceActor, id: string): Promise<ArtefactMetadata | null>;
}

/** Tenant-scoped handles. Conversations/messages/executions are the chat-turn slice; jobs and artefacts are not required to pass through chat. */
export interface ActorBoundPersistence {
  actor: PersistenceActor;
  conversations: ConversationRepository;
  messages: MessageRepository;
  executions: ExecutionRepository;
  provenance: ProvenanceWriter;
  events: EventBus;
  jobs: DurableJobEngine;
  behaviour: DurableBehaviourStore;
  workspaces: WorkspaceStore;
}

export interface RestartRecoveryResult {
  executions: ExecutionRecord[];
  jobs: Awaited<ReturnType<DurableJobEngine['recoverExpiredLeases']>>;
  runtimeLeases: RuntimeLeaseRecord[];
}

export interface PlatformPersistence extends UnitOfWork {
  readonly mode: PersistenceMode;
  forActor(actor: PersistenceActor): ActorBoundPersistence;
  ensureTenant(input: { id: string; name: string }): Promise<TenantRecord>;
  ensurePrincipal(input: { id: string; displayName?: string | null }): Promise<PrincipalRecord>;
  ensureWorkspace(
    actor: PersistenceActor,
    input: { id?: string; name: string; dungeon?: string },
  ): Promise<WorkspaceRecord>;
  runtimeLeases: RuntimeLeaseStore;
  artefacts: ArtefactMetadataStore;
  recoverOnStart(reason?: string): Promise<RestartRecoveryResult>;
  applyEventRetention(maxEntries?: number): Promise<number>;
  close(): Promise<void>;
}

export type { Conversation, Message, ExecutionRecord, ProvenanceRecord };
