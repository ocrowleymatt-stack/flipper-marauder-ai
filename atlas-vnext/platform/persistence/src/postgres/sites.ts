import { assertActor, type PersistenceActor } from '../actor.ts';
import { OwnershipError } from '../errors.ts';
import type {
  SiteRecord,
  SiteRetentionClass,
  SiteRevisionEntry,
  SiteRevisionRecord,
  SiteStore,
} from '../site-types.ts';
import { isoRequired, sqlRow } from './mappers.ts';
import type { PgTx } from './tx.ts';

function mapSite(row: SiteRow): SiteRecord {
  return {
    id: row.id,
    urn: row.urn,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    name: row.name,
    currentRevisionId: row.current_revision_id,
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
    deletedAt: row.deleted_at ? isoRequired(row.deleted_at) : null,
  };
}

function mapRevision(row: SiteRevisionRow): SiteRevisionRecord {
  return {
    id: row.id,
    siteId: row.site_id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    artefactId: row.artefact_id,
    parentId: row.parent_id,
    version: Number(row.version),
    manifestHash: row.manifest_hash,
    retentionClass: row.retention_class as SiteRetentionClass,
    pinReason: row.pin_reason,
    retainedUntil: row.retained_until ? isoRequired(row.retained_until) : null,
    expiredAt: row.expired_at ? isoRequired(row.expired_at) : null,
    createdAt: isoRequired(row.created_at),
  };
}

function mapEntry(row: SiteEntryRow): SiteRevisionEntry {
  return {
    revisionId: row.revision_id,
    tenantId: row.tenant_id,
    path: row.path,
    contentHash: row.content_hash,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
  };
}

export function createSiteStores(tx: PgTx, clock: () => string): { sites: SiteStore } {
  const sites: SiteStore = {
    async create(actor, input) {
      const scoped = assertActor(actor, 'create site');
      const now = clock();
      const inserted = await tx.query<SiteRow>(
        `INSERT INTO site_records (
           id, urn, tenant_id, workspace_id, name, current_revision_id, created_at, updated_at, deleted_at
         )
         VALUES ($1,$2,$3,$4,$5,NULL,$6,$6,NULL)
         RETURNING *`,
        [
          input.id,
          input.urn ?? `urn:atlas:site:${input.id}`,
          scoped.tenantId,
          input.workspaceId,
          input.name,
          now,
        ],
      );
      return mapSite(sqlRow(inserted.rows[0]!));
    },
    async get(actor, id) {
      const scoped = assertActor(actor, 'read site');
      const result = await tx.query<SiteRow>(
        'SELECT * FROM site_records WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
        [id, scoped.tenantId],
      );
      const row = result.rows[0];
      if (!row) return null;
      if (scoped.workspaceId && row.workspace_id !== scoped.workspaceId) return null;
      return mapSite(sqlRow(row));
    },
    async getByName(actor, workspaceId, name) {
      const scoped = assertActor(actor, 'read site by name');
      if (scoped.workspaceId && scoped.workspaceId !== workspaceId) return null;
      const result = await tx.query<SiteRow>(
        `SELECT * FROM site_records
         WHERE tenant_id = $1 AND workspace_id = $2 AND name = $3 AND deleted_at IS NULL`,
        [scoped.tenantId, workspaceId, name],
      );
      return result.rows[0] ? mapSite(sqlRow(result.rows[0])) : null;
    },
    async list(actor, workspaceId) {
      const scoped = assertActor(actor, 'list sites');
      if (scoped.workspaceId && scoped.workspaceId !== workspaceId) return [];
      const result = await tx.query<SiteRow>(
        `SELECT * FROM site_records
         WHERE tenant_id = $1 AND workspace_id = $2 AND deleted_at IS NULL
         ORDER BY name`,
        [scoped.tenantId, workspaceId],
      );
      return result.rows.map((row) => mapSite(sqlRow(row)));
    },
    async listAll(actor) {
      const scoped = assertActor(actor, 'list all sites');
      const result = scoped.workspaceId
        ? await tx.query<SiteRow>(
            `SELECT * FROM site_records
             WHERE tenant_id = $1 AND workspace_id = $2 AND deleted_at IS NULL
             ORDER BY name`,
            [scoped.tenantId, scoped.workspaceId],
          )
        : await tx.query<SiteRow>(
            `SELECT * FROM site_records WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY name`,
            [scoped.tenantId],
          );
      return result.rows.map((row) => mapSite(sqlRow(row)));
    },
    async setCurrentRevision(actor, siteId, revisionId) {
      const scoped = assertActor(actor, 'set site current revision');
      const now = clock();
      const result = await tx.query<SiteRow>(
        `UPDATE site_records SET current_revision_id = $3, updated_at = $4
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         RETURNING *`,
        [siteId, scoped.tenantId, revisionId, now],
      );
      if (!result.rows[0]) {
        throw new OwnershipError(`Fail-closed: site ${siteId} is not visible to tenant ${scoped.tenantId}.`);
      }
      return mapSite(sqlRow(result.rows[0]));
    },
    async createRevision(actor, row) {
      const scoped = assertActor(actor, 'create site revision');
      const inserted = await tx.query<SiteRevisionRow>(
        `INSERT INTO site_revisions (
           id, site_id, tenant_id, workspace_id, artefact_id, parent_id, version, manifest_hash,
           retention_class, pin_reason, retained_until, expired_at, created_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          row.id,
          row.siteId,
          scoped.tenantId,
          row.workspaceId,
          row.artefactId,
          row.parentId,
          row.version,
          row.manifestHash,
          row.retentionClass,
          row.pinReason,
          row.retainedUntil,
          row.expiredAt ?? null,
          row.createdAt ?? clock(),
        ],
      );
      return mapRevision(sqlRow(inserted.rows[0]!));
    },
    async getRevision(actor, id) {
      const scoped = assertActor(actor, 'read site revision');
      const result = await tx.query<SiteRevisionRow>(
        'SELECT * FROM site_revisions WHERE id = $1 AND tenant_id = $2',
        [id, scoped.tenantId],
      );
      const mapped = result.rows[0] ? mapRevision(sqlRow(result.rows[0])) : null;
      if (!mapped) return null;
      if (scoped.workspaceId && mapped.workspaceId !== scoped.workspaceId) return null;
      return mapped;
    },
    async listRevisions(actor, siteId, opts) {
      const scoped = assertActor(actor, 'list site revisions');
      const result = opts?.includeExpired
        ? await tx.query<SiteRevisionRow>(
            `SELECT * FROM site_revisions WHERE tenant_id = $1 AND site_id = $2 ORDER BY version`,
            [scoped.tenantId, siteId],
          )
        : await tx.query<SiteRevisionRow>(
            `SELECT * FROM site_revisions
             WHERE tenant_id = $1 AND site_id = $2 AND expired_at IS NULL
             ORDER BY version`,
            [scoped.tenantId, siteId],
          );
      return result.rows
        .map((row) => mapRevision(sqlRow(row)))
        .filter((item) => !scoped.workspaceId || item.workspaceId === scoped.workspaceId);
    },
    async expireRevision(actor, id) {
      const scoped = assertActor(actor, 'expire site revision');
      const now = clock();
      const result = await tx.query<SiteRevisionRow>(
        `UPDATE site_revisions SET expired_at = $3
         WHERE id = $1 AND tenant_id = $2 AND expired_at IS NULL
         RETURNING *`,
        [id, scoped.tenantId, now],
      );
      if (!result.rows[0]) {
        throw new OwnershipError(`Fail-closed: site revision ${id} is not visible to tenant ${scoped.tenantId}.`);
      }
      return mapRevision(sqlRow(result.rows[0]));
    },
    async setRetentionClass(actor, id, retentionClass, pinReason) {
      const scoped = assertActor(actor, 'set site retention class');
      const result = await tx.query<SiteRevisionRow>(
        `UPDATE site_revisions SET retention_class = $3, pin_reason = $4
         WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
        [id, scoped.tenantId, retentionClass, pinReason ?? null],
      );
      if (!result.rows[0]) {
        throw new OwnershipError(`Fail-closed: site revision ${id} is not visible to tenant ${scoped.tenantId}.`);
      }
      return mapRevision(sqlRow(result.rows[0]));
    },
    async replaceEntries(actor, revisionId, entries) {
      const scoped = assertActor(actor, 'replace site revision entries');
      await tx.query('DELETE FROM site_revision_entries WHERE revision_id = $1 AND tenant_id = $2', [
        revisionId,
        scoped.tenantId,
      ]);
      const saved: SiteRevisionEntry[] = [];
      for (const entry of entries) {
        const inserted = await tx.query<SiteEntryRow>(
          `INSERT INTO site_revision_entries (revision_id, path, tenant_id, content_hash, mime_type, size_bytes)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING *`,
          [revisionId, entry.path, scoped.tenantId, entry.contentHash, entry.mimeType, entry.sizeBytes],
        );
        saved.push(mapEntry(sqlRow(inserted.rows[0]!)));
      }
      return saved;
    },
    async listEntries(actor, revisionId) {
      const scoped = assertActor(actor, 'list site revision entries');
      const result = await tx.query<SiteEntryRow>(
        `SELECT * FROM site_revision_entries WHERE tenant_id = $1 AND revision_id = $2 ORDER BY path`,
        [scoped.tenantId, revisionId],
      );
      return result.rows.map((row) => mapEntry(sqlRow(row)));
    },
    async counts(actor, workspaceId) {
      const scoped = assertActor(actor, 'count sites');
      const siteFilter = workspaceId ?? scoped.workspaceId ?? null;
      const sites = await tx.query<{ n: string | number }>(
        siteFilter
          ? `SELECT COUNT(*)::int AS n FROM site_records
             WHERE tenant_id = $1 AND workspace_id = $2 AND deleted_at IS NULL`
          : `SELECT COUNT(*)::int AS n FROM site_records WHERE tenant_id = $1 AND deleted_at IS NULL`,
        siteFilter ? [scoped.tenantId, siteFilter] : [scoped.tenantId],
      );
      const retained = await tx.query<{ n: string | number }>(
        siteFilter
          ? `SELECT COUNT(*)::int AS n FROM site_revisions
             WHERE tenant_id = $1 AND workspace_id = $2 AND expired_at IS NULL`
          : `SELECT COUNT(*)::int AS n FROM site_revisions WHERE tenant_id = $1 AND expired_at IS NULL`,
        siteFilter ? [scoped.tenantId, siteFilter] : [scoped.tenantId],
      );
      const expired = await tx.query<{ n: string | number }>(
        siteFilter
          ? `SELECT COUNT(*)::int AS n FROM site_revisions
             WHERE tenant_id = $1 AND workspace_id = $2 AND expired_at IS NOT NULL`
          : `SELECT COUNT(*)::int AS n FROM site_revisions WHERE tenant_id = $1 AND expired_at IS NOT NULL`,
        siteFilter ? [scoped.tenantId, siteFilter] : [scoped.tenantId],
      );
      const bytes = await tx.query<{ n: string | number }>(
        siteFilter
          ? `SELECT COALESCE(SUM(e.size_bytes), 0)::bigint AS n
             FROM site_revision_entries e
             JOIN site_revisions r ON r.id = e.revision_id
             WHERE e.tenant_id = $1 AND r.workspace_id = $2 AND r.expired_at IS NULL`
          : `SELECT COALESCE(SUM(e.size_bytes), 0)::bigint AS n
             FROM site_revision_entries e
             JOIN site_revisions r ON r.id = e.revision_id
             WHERE e.tenant_id = $1 AND r.expired_at IS NULL`,
        siteFilter ? [scoped.tenantId, siteFilter] : [scoped.tenantId],
      );
      const unique = await tx.query<{ n: string | number }>(
        siteFilter
          ? `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS n
             FROM (
               SELECT DISTINCT e.content_hash, e.size_bytes
               FROM site_revision_entries e
               JOIN site_revisions r ON r.id = e.revision_id
               WHERE e.tenant_id = $1 AND r.workspace_id = $2 AND r.expired_at IS NULL
             ) unique_entries`
          : `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS n
             FROM (
               SELECT DISTINCT e.content_hash, e.size_bytes
               FROM site_revision_entries e
               JOIN site_revisions r ON r.id = e.revision_id
               WHERE e.tenant_id = $1 AND r.expired_at IS NULL
             ) unique_entries`,
        siteFilter ? [scoped.tenantId, siteFilter] : [scoped.tenantId],
      );
      return {
        logicalSites: Number(sites.rows[0]?.n ?? 0),
        retainedRevisions: Number(retained.rows[0]?.n ?? 0),
        expiredRevisions: Number(expired.rows[0]?.n ?? 0),
        logicalBytes: Number(bytes.rows[0]?.n ?? 0),
        uniqueBytes: Number(unique.rows[0]?.n ?? 0),
      };
    },
  };

  return { sites };
}

interface SiteRow {
  id: string;
  urn: string;
  tenant_id: string;
  workspace_id: string;
  name: string;
  current_revision_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
}

interface SiteRevisionRow {
  id: string;
  site_id: string;
  tenant_id: string;
  workspace_id: string;
  artefact_id: string | null;
  parent_id: string | null;
  version: number | string;
  manifest_hash: string;
  retention_class: string;
  pin_reason: string | null;
  retained_until: Date | string | null;
  expired_at: Date | string | null;
  created_at: Date | string;
}

interface SiteEntryRow {
  revision_id: string;
  path: string;
  tenant_id: string;
  content_hash: string;
  mime_type: string;
  size_bytes: string | number;
}
