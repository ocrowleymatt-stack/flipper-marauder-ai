import type { DungeonId, DungeonRecordStatus, StructuredFailure } from '@atlas-vnext/contracts';
import type { PersistenceActor } from './actor.ts';

export interface DungeonRecordRow {
  id: string;
  urn: string;
  tenantId: string;
  workspaceId: string | null;
  dungeon: DungeonId;
  kind: string;
  title: string;
  status: DungeonRecordStatus;
  payload: Record<string, unknown>;
  artefactId: string | null;
  contentHash: string | null;
  jobId: string | null;
  conversationId: string | null;
  parentId: string | null;
  revision: number;
  failure: StructuredFailure | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface PrivacyPolicyRow {
  id: string;
  tenantId: string;
  dungeonId: DungeonId | null;
  payload: Record<string, unknown>;
  revision: number;
  updatedBy: string;
  updatedAt: string;
}

export interface PrivacyAuditRow {
  id: string;
  tenantId: string;
  actorId: string;
  action: string;
  capability: string;
  resource: string | null;
  decision: string;
  reasonCode: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  stepUp: boolean;
  at: string;
}

export interface PrivacyProposalRow {
  id: string;
  tenantId: string;
  proposedBy: string;
  dungeonId: DungeonId | null;
  patch: Record<string, unknown>;
  status: 'proposed' | 'approved' | 'denied';
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface DungeonRecordStore {
  create(
    actor: PersistenceActor,
    input: {
      id?: string;
      workspaceId?: string | null;
      dungeon: DungeonId;
      kind: string;
      title: string;
      status?: DungeonRecordStatus;
      payload?: Record<string, unknown>;
      artefactId?: string | null;
      contentHash?: string | null;
      jobId?: string | null;
      conversationId?: string | null;
      parentId?: string | null;
    },
  ): Promise<DungeonRecordRow>;
  get(actor: PersistenceActor, id: string): Promise<DungeonRecordRow | null>;
  list(
    actor: PersistenceActor,
    input: { workspaceId?: string | null; dungeon: DungeonId; kind?: string; parentId?: string | null },
  ): Promise<DungeonRecordRow[]>;
  update(
    actor: PersistenceActor,
    id: string,
    patch: {
      title?: string;
      status?: DungeonRecordStatus;
      payload?: Record<string, unknown>;
      artefactId?: string | null;
      contentHash?: string | null;
      jobId?: string | null;
      conversationId?: string | null;
      failure?: StructuredFailure | null;
      expectedRevision: number;
    },
  ): Promise<DungeonRecordRow>;
  logicalDelete(actor: PersistenceActor, id: string, expectedRevision?: number): Promise<DungeonRecordRow>;
}

export interface PrivacyStore {
  getPolicy(actor: PersistenceActor, dungeonId: DungeonId | null): Promise<PrivacyPolicyRow | null>;
  listPolicies(actor: PersistenceActor): Promise<PrivacyPolicyRow[]>;
  upsertPolicy(
    actor: PersistenceActor,
    input: { dungeonId: DungeonId | null; payload: Record<string, unknown>; expectedRevision?: number; updatedBy: string },
  ): Promise<PrivacyPolicyRow>;
  appendAudit(actor: PersistenceActor, row: Omit<PrivacyAuditRow, 'id' | 'tenantId' | 'at'> & { id?: string; at?: string }): Promise<PrivacyAuditRow>;
  listAudit(actor: PersistenceActor, limit?: number): Promise<PrivacyAuditRow[]>;
  createProposal(
    actor: PersistenceActor,
    input: { proposedBy: string; dungeonId: DungeonId | null; patch: Record<string, unknown> },
  ): Promise<PrivacyProposalRow>;
  listProposals(actor: PersistenceActor): Promise<PrivacyProposalRow[]>;
  decideProposal(
    actor: PersistenceActor,
    id: string,
    input: { status: 'approved' | 'denied'; decidedBy: string },
  ): Promise<PrivacyProposalRow>;
}
