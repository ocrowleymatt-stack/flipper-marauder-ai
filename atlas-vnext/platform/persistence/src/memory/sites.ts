import { assertActor, sameWorkspace, type PersistenceActor } from '../actor.ts';
import { OwnershipError } from '../errors.ts';
import type {
  SiteRecord,
  SiteRevisionEntry,
  SiteRevisionRecord,
  SiteStore,
} from '../site-types.ts';

export function createMemorySiteStores(clock: () => string): { sites: SiteStore } {
  const records = new Map<string, SiteRecord>();
  const revisions = new Map<string, SiteRevisionRecord>();
  const entries = new Map<string, SiteRevisionEntry[]>();

  function visibleSite(actor: PersistenceActor, record: SiteRecord | undefined): SiteRecord | null {
    if (!record || record.tenantId !== actor.tenantId || record.deletedAt) return null;
    if (!sameWorkspace(actor, record.workspaceId)) return null;
    return record;
  }

  const sites: SiteStore = {
    async create(actor, input) {
      const scoped = assertActor(actor, 'create site');
      const now = clock();
      const record: SiteRecord = {
        id: input.id,
        urn: input.urn ?? `urn:atlas:site:${input.id}`,
        tenantId: scoped.tenantId,
        workspaceId: input.workspaceId,
        name: input.name,
        currentRevisionId: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      records.set(record.id, record);
      return record;
    },
    async get(actor, id) {
      const scoped = assertActor(actor, 'read site');
      return visibleSite(scoped, records.get(id));
    },
    async getByName(actor, workspaceId, name) {
      const scoped = assertActor(actor, 'read site by name');
      if (!sameWorkspace(scoped, workspaceId)) return null;
      return (
        [...records.values()].find(
          (item) =>
            item.tenantId === scoped.tenantId &&
            item.workspaceId === workspaceId &&
            item.name === name &&
            !item.deletedAt,
        ) ?? null
      );
    },
    async list(actor, workspaceId) {
      const scoped = assertActor(actor, 'list sites');
      if (!sameWorkspace(scoped, workspaceId)) return [];
      return [...records.values()]
        .filter(
          (item) => item.tenantId === scoped.tenantId && item.workspaceId === workspaceId && !item.deletedAt,
        )
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async listAll(actor) {
      const scoped = assertActor(actor, 'list all sites');
      return [...records.values()]
        .filter((item) => item.tenantId === scoped.tenantId && !item.deletedAt)
        .filter((item) => sameWorkspace(scoped, item.workspaceId))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async setCurrentRevision(actor, siteId, revisionId) {
      const scoped = assertActor(actor, 'set site current revision');
      const existing = visibleSite(scoped, records.get(siteId));
      if (!existing) {
        throw new OwnershipError(`Fail-closed: site ${siteId} is not visible to tenant ${scoped.tenantId}.`);
      }
      const next = { ...existing, currentRevisionId: revisionId, updatedAt: clock() };
      records.set(siteId, next);
      return next;
    },
    async createRevision(actor, row) {
      const scoped = assertActor(actor, 'create site revision');
      const record: SiteRevisionRecord = {
        ...row,
        tenantId: scoped.tenantId,
        expiredAt: row.expiredAt ?? null,
        createdAt: row.createdAt ?? clock(),
      };
      revisions.set(record.id, record);
      return record;
    },
    async getRevision(actor, id) {
      const scoped = assertActor(actor, 'read site revision');
      const record = revisions.get(id);
      if (!record || record.tenantId !== scoped.tenantId) return null;
      if (!sameWorkspace(scoped, record.workspaceId)) return null;
      return record;
    },
    async listRevisions(actor, siteId, opts) {
      const scoped = assertActor(actor, 'list site revisions');
      return [...revisions.values()]
        .filter((item) => item.tenantId === scoped.tenantId && item.siteId === siteId)
        .filter((item) => sameWorkspace(scoped, item.workspaceId))
        .filter((item) => opts?.includeExpired || !item.expiredAt)
        .sort((a, b) => a.version - b.version);
    },
    async expireRevision(actor, id) {
      const scoped = assertActor(actor, 'expire site revision');
      const existing = await sites.getRevision(actor, id);
      if (!existing || existing.expiredAt) {
        throw new OwnershipError(`Fail-closed: site revision ${id} is not visible to tenant ${scoped.tenantId}.`);
      }
      const next = { ...existing, expiredAt: clock() };
      revisions.set(id, next);
      return next;
    },
    async setRetentionClass(actor, id, retentionClass, pinReason) {
      const scoped = assertActor(actor, 'set site retention class');
      const existing = await sites.getRevision(actor, id);
      if (!existing) {
        throw new OwnershipError(`Fail-closed: site revision ${id} is not visible to tenant ${scoped.tenantId}.`);
      }
      const next = { ...existing, retentionClass, pinReason: pinReason ?? null };
      revisions.set(id, next);
      return next;
    },
    async replaceEntries(actor, revisionId, nextEntries) {
      const scoped = assertActor(actor, 'replace site revision entries');
      const saved: SiteRevisionEntry[] = nextEntries.map((entry) => ({
        revisionId,
        tenantId: scoped.tenantId,
        path: entry.path,
        contentHash: entry.contentHash,
        mimeType: entry.mimeType,
        sizeBytes: entry.sizeBytes,
      }));
      entries.set(revisionId, saved);
      return saved;
    },
    async listEntries(actor, revisionId) {
      const scoped = assertActor(actor, 'list site revision entries');
      return (entries.get(revisionId) ?? [])
        .filter((item) => item.tenantId === scoped.tenantId)
        .sort((a, b) => a.path.localeCompare(b.path));
    },
    async counts(actor, workspaceId) {
      const scoped = assertActor(actor, 'count sites');
      const siteFilter = workspaceId ?? scoped.workspaceId ?? null;
      const siteRows = [...records.values()].filter(
        (item) => item.tenantId === scoped.tenantId && !item.deletedAt && (!siteFilter || item.workspaceId === siteFilter),
      );
      const revisionRows = [...revisions.values()].filter(
        (item) => item.tenantId === scoped.tenantId && (!siteFilter || item.workspaceId === siteFilter),
      );
      const retained = revisionRows.filter((item) => !item.expiredAt);
      const unique = new Map<string, number>();
      let logicalBytes = 0;
      for (const revision of retained) {
        for (const entry of entries.get(revision.id) ?? []) {
          if (entry.tenantId !== scoped.tenantId) continue;
          logicalBytes += entry.sizeBytes;
          unique.set(entry.contentHash, entry.sizeBytes);
        }
      }
      return {
        logicalSites: siteRows.length,
        retainedRevisions: retained.length,
        expiredRevisions: revisionRows.length - retained.length,
        logicalBytes,
        uniqueBytes: [...unique.values()].reduce((sum, size) => sum + size, 0),
      };
    },
  };

  return { sites };
}

export type MemorySiteStores = ReturnType<typeof createMemorySiteStores>;
