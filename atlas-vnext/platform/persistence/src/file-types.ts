import type { PersistenceActor } from './actor.ts';

export type FileStatus = 'active' | 'deleted';
export type ExtractionStatus = 'pending' | 'succeeded' | 'failed';
export type CasRefKind =
  | 'file'
  | 'file_version'
  | 'extraction'
  | 'artefact'
  | 'chunk'
  | 'site_revision'
  | 'site_entry';

export interface CasCatalogStats {
  objectCount: number;
  catalogBytes: number;
  unreferencedCount: number;
  unreferencedBytes: number;
}

export interface ChunkLocator {
  path: string;
  startOffset: number;
  endOffset: number;
  page?: number;
  heading?: string;
  row?: number;
  jsonPath?: string;
}

export interface FileRecord {
  id: string;
  urn: string;
  tenantId: string;
  workspaceId: string;
  path: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  status: FileStatus;
  artefactId: string | null;
  createdBy: string | null;
  revision: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface FileVersionRecord {
  id: string;
  fileId: string;
  tenantId: string;
  workspaceId: string;
  version: number;
  contentHash: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ExtractionRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  fileId: string | null;
  contentHash: string;
  extractor: string;
  extractorVersion: string;
  status: ExtractionStatus;
  pageCount: number | null;
  structure: Record<string, unknown>;
  textHash: string | null;
  error: { code: string; message: string } | null;
  jobId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChunkRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  fileId: string;
  contentHash: string;
  chunker: string;
  chunkerVersion: string;
  ordinal: number;
  startOffset: number;
  endOffset: number;
  locator: ChunkLocator;
  text: string;
  tokenCount: number;
  createdAt: string;
}

export interface AttachmentRecord {
  id: string;
  tenantId: string;
  workspaceId: string | null;
  conversationId: string;
  messageId: string | null;
  fileId: string;
  contentHash: string;
  createdAt: string;
  detachedAt: string | null;
}

export interface CasObjectRecord {
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  refCount: number;
}

export interface CasRefRecord {
  id: string;
  sha256: string;
  tenantId: string;
  workspaceId: string | null;
  kind: CasRefKind;
  ownerId: string;
  createdAt: string;
}

export interface FileStore {
  create(actor: PersistenceActor, input: Omit<FileRecord, 'tenantId' | 'urn' | 'createdAt' | 'updatedAt' | 'status' | 'deletedAt' | 'revision' | 'version'> & {
    urn?: string;
    status?: FileStatus;
    revision?: number;
    version?: number;
    createdAt?: string;
  }): Promise<FileRecord>;
  get(actor: PersistenceActor, id: string): Promise<FileRecord | null>;
  getByPath(actor: PersistenceActor, workspaceId: string, path: string): Promise<FileRecord | null>;
  list(actor: PersistenceActor, workspaceId: string, opts?: { includeDeleted?: boolean }): Promise<FileRecord[]>;
  update(actor: PersistenceActor, id: string, patch: Partial<Pick<FileRecord, 'path' | 'displayName' | 'mimeType' | 'sizeBytes' | 'contentHash' | 'artefactId' | 'version' | 'revision'>> & { expectedRevision: number }): Promise<FileRecord>;
  logicalDelete(actor: PersistenceActor, id: string): Promise<FileRecord>;
}

export interface FileVersionStore {
  append(actor: PersistenceActor, row: Omit<FileVersionRecord, 'tenantId' | 'createdAt'> & { createdAt?: string }): Promise<FileVersionRecord>;
  list(actor: PersistenceActor, fileId: string): Promise<FileVersionRecord[]>;
}

export interface ExtractionStore {
  record(actor: PersistenceActor, row: Omit<ExtractionRecord, 'tenantId' | 'createdAt' | 'updatedAt'> & { createdAt?: string }): Promise<ExtractionRecord>;
  getByHash(
    actor: PersistenceActor,
    contentHash: string,
    extractor: string,
    extractorVersion: string,
  ): Promise<ExtractionRecord | null>;
  get(actor: PersistenceActor, id: string): Promise<ExtractionRecord | null>;
}

export interface ChunkStore {
  replaceForHash(
    actor: PersistenceActor,
    input: {
      fileId: string;
      workspaceId: string;
      contentHash: string;
      chunker: string;
      chunkerVersion: string;
      chunks: Array<Omit<ChunkRecord, 'id' | 'tenantId' | 'workspaceId' | 'fileId' | 'contentHash' | 'chunker' | 'chunkerVersion' | 'createdAt'> & { id?: string }>;
    },
  ): Promise<ChunkRecord[]>;
  listForFile(actor: PersistenceActor, fileId: string): Promise<ChunkRecord[]>;
  listForHash(actor: PersistenceActor, contentHash: string, chunker: string, chunkerVersion: string): Promise<ChunkRecord[]>;
  search(actor: PersistenceActor, workspaceId: string, query: string, limit?: number): Promise<Array<ChunkRecord & { rank: number }>>;
  get(actor: PersistenceActor, id: string): Promise<ChunkRecord | null>;
}

export interface AttachmentStore {
  attach(actor: PersistenceActor, input: Omit<AttachmentRecord, 'tenantId' | 'createdAt' | 'detachedAt' | 'id'> & { id?: string }): Promise<AttachmentRecord>;
  detach(actor: PersistenceActor, id: string): Promise<AttachmentRecord>;
  listByConversation(actor: PersistenceActor, conversationId: string, opts?: { includeDetached?: boolean }): Promise<AttachmentRecord[]>;
  get(actor: PersistenceActor, id: string): Promise<AttachmentRecord | null>;
}

export interface CasRefStore {
  ensureObject(sha256: string, sizeBytes: number): Promise<CasObjectRecord>;
  getObject(sha256: string): Promise<CasObjectRecord | null>;
  addRef(actor: PersistenceActor, input: Omit<CasRefRecord, 'tenantId' | 'createdAt' | 'id'> & { id?: string }): Promise<CasRefRecord>;
  removeRef(actor: PersistenceActor, kind: CasRefKind, ownerId: string, sha256: string): Promise<void>;
  removeRefsByOwner(actor: PersistenceActor, ownerId: string, kind?: CasRefKind): Promise<number>;
  listRefsByOwner(actor: PersistenceActor, ownerId: string): Promise<CasRefRecord[]>;
  refCount(sha256: string): Promise<number>;
  hasTenantAccess(actor: PersistenceActor, sha256: string): Promise<boolean>;
  listUnreferenced(limit?: number): Promise<CasObjectRecord[]>;
  deleteObject(sha256: string): Promise<void>;
  stats(): Promise<CasCatalogStats>;
}
