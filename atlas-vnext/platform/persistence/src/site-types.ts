import type { PersistenceActor } from './actor.ts';

export type SiteRetentionClass = 'ephemeral' | 'pinned' | 'published';

export interface SiteRecord {
  id: string;
  urn: string;
  tenantId: string;
  workspaceId: string;
  name: string;
  currentRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface SiteRevisionRecord {
  id: string;
  siteId: string;
  tenantId: string;
  workspaceId: string;
  artefactId: string | null;
  parentId: string | null;
  version: number;
  manifestHash: string;
  retentionClass: SiteRetentionClass;
  pinReason: string | null;
  retainedUntil: string | null;
  expiredAt: string | null;
  createdAt: string;
}

export interface SiteRevisionEntry {
  revisionId: string;
  tenantId: string;
  path: string;
  contentHash: string;
  mimeType: string;
  sizeBytes: number;
}

export interface SiteCounts {
  logicalSites: number;
  retainedRevisions: number;
  expiredRevisions: number;
  logicalBytes: number;
  uniqueBytes: number;
}

export interface SiteStore {
  create(
    actor: PersistenceActor,
    input: { id: string; workspaceId: string; name: string; urn?: string },
  ): Promise<SiteRecord>;
  get(actor: PersistenceActor, id: string): Promise<SiteRecord | null>;
  getByName(actor: PersistenceActor, workspaceId: string, name: string): Promise<SiteRecord | null>;
  list(actor: PersistenceActor, workspaceId: string): Promise<SiteRecord[]>;
  listAll(actor: PersistenceActor): Promise<SiteRecord[]>;
  setCurrentRevision(actor: PersistenceActor, siteId: string, revisionId: string): Promise<SiteRecord>;
  createRevision(
    actor: PersistenceActor,
    row: Omit<SiteRevisionRecord, 'tenantId' | 'createdAt' | 'expiredAt'> & {
      createdAt?: string;
      expiredAt?: string | null;
    },
  ): Promise<SiteRevisionRecord>;
  getRevision(actor: PersistenceActor, id: string): Promise<SiteRevisionRecord | null>;
  listRevisions(
    actor: PersistenceActor,
    siteId: string,
    opts?: { includeExpired?: boolean },
  ): Promise<SiteRevisionRecord[]>;
  expireRevision(actor: PersistenceActor, id: string): Promise<SiteRevisionRecord>;
  setRetentionClass(
    actor: PersistenceActor,
    id: string,
    retentionClass: SiteRetentionClass,
    pinReason?: string | null,
  ): Promise<SiteRevisionRecord>;
  replaceEntries(
    actor: PersistenceActor,
    revisionId: string,
    entries: Array<{ path: string; contentHash: string; mimeType: string; sizeBytes: number }>,
  ): Promise<SiteRevisionEntry[]>;
  listEntries(actor: PersistenceActor, revisionId: string): Promise<SiteRevisionEntry[]>;
  counts(actor: PersistenceActor, workspaceId?: string): Promise<SiteCounts>;
}
