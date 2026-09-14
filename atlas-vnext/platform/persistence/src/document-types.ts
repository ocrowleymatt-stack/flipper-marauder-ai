import type { StructuredFailure } from '@atlas-vnext/contracts';
import type { PersistenceActor } from './actor.ts';

export type DocumentStatus =
  | 'idle'
  | 'requested'
  | 'running'
  | 'streaming'
  | 'candidate'
  | 'committed'
  | 'failed';

export interface DocumentRecord {
  id: string;
  urn: string;
  tenantId: string;
  workspaceId: string;
  title: string;
  status: DocumentStatus;
  currentVersion: number;
  revision: number;
  currentContentHash: string | null;
  draftContentHash: string | null;
  currentArtefactId: string | null;
  draftArtefactId: string | null;
  conversationId: string | null;
  originatingRunId: string | null;
  failure: StructuredFailure | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface DocumentVersionRecord {
  id: string;
  documentId: string;
  tenantId: string;
  workspaceId: string;
  version: number;
  contentHash: string;
  artefactId: string;
  title: string;
  operation: string;
  executionId: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface DocumentStore {
  create(
    actor: PersistenceActor,
    input: {
      id?: string;
      workspaceId: string;
      title: string;
      conversationId?: string | null;
    },
  ): Promise<DocumentRecord>;
  get(actor: PersistenceActor, id: string, opts?: { includeDeleted?: boolean }): Promise<DocumentRecord | null>;
  list(actor: PersistenceActor, workspaceId: string): Promise<DocumentRecord[]>;
  update(
    actor: PersistenceActor,
    id: string,
    patch: {
      title?: string;
      status?: DocumentStatus;
      conversationId?: string | null;
      originatingRunId?: string | null;
      draftContentHash?: string | null;
      currentContentHash?: string | null;
      currentArtefactId?: string | null;
      draftArtefactId?: string | null;
      failure?: StructuredFailure | null;
      expectedRevision: number;
    },
  ): Promise<DocumentRecord>;
  logicalDelete(actor: PersistenceActor, id: string, expectedRevision?: number): Promise<DocumentRecord>;
  listInFlight(): Promise<DocumentRecord[]>;
  addVersion(
    actor: PersistenceActor,
    documentId: string,
    input: {
      contentHash: string;
      artefactId: string;
      title: string;
      operation: string;
      executionId?: string | null;
      expectedRevision: number;
    },
  ): Promise<{ document: DocumentRecord; version: DocumentVersionRecord }>;
  listVersions(actor: PersistenceActor, documentId: string): Promise<DocumentVersionRecord[]>;
  getVersion(actor: PersistenceActor, documentId: string, version: number): Promise<DocumentVersionRecord | null>;
}
