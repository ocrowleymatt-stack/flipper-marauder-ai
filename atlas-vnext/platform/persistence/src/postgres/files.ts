import { randomUUID } from 'node:crypto';
import { logPlatform } from '@atlas-vnext/observability';
import { assertActor, type PersistenceActor } from '../actor.ts';
import { ConflictError, OwnershipError } from '../errors.ts';
import type {
  AttachmentRecord,
  AttachmentStore,
  CasCatalogStats,
  CasObjectRecord,
  CasRefKind,
  CasRefRecord,
  CasRefStore,
  ChunkLocator,
  ChunkRecord,
  ChunkStore,
  ExtractionRecord,
  ExtractionStore,
  FileRecord,
  FileStore,
  FileVersionRecord,
  FileVersionStore,
} from '../file-types.ts';
import { asJson, isoRequired, sqlRow } from './mappers.ts';
import type { PgTx } from './tx.ts';

function mapFile(row: FileRow): FileRecord {
  return {
    id: row.id,
    urn: row.urn,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    path: row.path,
    displayName: row.display_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    contentHash: row.content_hash,
    status: row.status as FileRecord['status'],
    artefactId: row.artefact_id,
    createdBy: row.created_by,
    revision: Number(row.revision),
    version: Number(row.version),
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
    deletedAt: row.deleted_at ? isoRequired(row.deleted_at) : null,
  };
}

function mapFileVersion(row: FileVersionRow): FileVersionRecord {
  return {
    id: row.id,
    fileId: row.file_id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    version: Number(row.version),
    contentHash: row.content_hash,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    createdAt: isoRequired(row.created_at),
  };
}

function mapExtraction(row: ExtractionRow): ExtractionRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    fileId: row.file_id,
    contentHash: row.content_hash,
    extractor: row.extractor,
    extractorVersion: row.extractor_version,
    status: row.status as ExtractionRecord['status'],
    pageCount: row.page_count == null ? null : Number(row.page_count),
    structure: asJson(row.structure, {}),
    textHash: row.text_hash,
    error: asJson(row.error, null),
    jobId: row.job_id,
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
  };
}

function mapChunk(row: ChunkRow): ChunkRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    fileId: row.file_id,
    contentHash: row.content_hash,
    chunker: row.chunker,
    chunkerVersion: row.chunker_version,
    ordinal: Number(row.ordinal),
    startOffset: Number(row.start_offset),
    endOffset: Number(row.end_offset),
    locator: asJson<ChunkLocator>(row.locator, { path: '', startOffset: 0, endOffset: 0 }),
    text: row.text,
    tokenCount: Number(row.token_count),
    createdAt: isoRequired(row.created_at),
  };
}

function mapAttachment(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    fileId: row.file_id,
    contentHash: row.content_hash,
    createdAt: isoRequired(row.created_at),
    detachedAt: row.detached_at ? isoRequired(row.detached_at) : null,
  };
}

export function createFileStores(tx: PgTx, clock: () => string) {
  const files: FileStore = {
    async create(actor, input) {
      const scoped = assertActor(actor, 'create file');
      const now = clock();
      const id = input.id;
      const inserted = await tx.query<FileRow>(
        `INSERT INTO files (
           id, urn, tenant_id, workspace_id, path, display_name, mime_type, size_bytes, content_hash,
           status, artefact_id, created_by, revision, version, created_at, updated_at, deleted_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,NULL)
         RETURNING *`,
        [
          id,
          input.urn ?? `urn:atlas:file:${id}`,
          scoped.tenantId,
          input.workspaceId,
          input.path,
          input.displayName,
          input.mimeType,
          input.sizeBytes,
          input.contentHash,
          input.status ?? 'active',
          input.artefactId ?? null,
          input.createdBy ?? scoped.principalId ?? null,
          input.revision ?? 1,
          input.version ?? 1,
          input.createdAt ?? now,
        ],
      );
      return mapFile(sqlRow(inserted.rows[0]!));
    },
    async get(actor, id) {
      const scoped = assertActor(actor, 'read file');
      const result = await tx.query<FileRow>(
        'SELECT * FROM files WHERE id = $1 AND tenant_id = $2',
        [id, scoped.tenantId],
      );
      const row = result.rows[0];
      if (!row) return null;
      if (scoped.workspaceId && row.workspace_id !== scoped.workspaceId) return null;
      return mapFile(sqlRow(row));
    },
    async getByPath(actor, workspaceId, path) {
      const scoped = assertActor(actor, 'read file by path');
      if (scoped.workspaceId && scoped.workspaceId !== workspaceId) return null;
      const result = await tx.query<FileRow>(
        `SELECT * FROM files
         WHERE tenant_id = $1 AND workspace_id = $2 AND path = $3 AND deleted_at IS NULL`,
        [scoped.tenantId, workspaceId, path],
      );
      return result.rows[0] ? mapFile(sqlRow(result.rows[0])) : null;
    },
    async list(actor, workspaceId, opts) {
      const scoped = assertActor(actor, 'list files');
      if (scoped.workspaceId && scoped.workspaceId !== workspaceId) return [];
      const result = opts?.includeDeleted
        ? await tx.query<FileRow>(
            `SELECT * FROM files WHERE tenant_id = $1 AND workspace_id = $2 ORDER BY path`,
            [scoped.tenantId, workspaceId],
          )
        : await tx.query<FileRow>(
            `SELECT * FROM files WHERE tenant_id = $1 AND workspace_id = $2 AND deleted_at IS NULL ORDER BY path`,
            [scoped.tenantId, workspaceId],
          );
      return result.rows.map((row) => mapFile(sqlRow(row)));
    },
    async update(actor, id, patch) {
      const scoped = assertActor(actor, 'update file');
      const now = clock();
      const result = await tx.query<FileRow>(
        `UPDATE files SET
           path = COALESCE($4, path),
           display_name = COALESCE($5, display_name),
           mime_type = COALESCE($6, mime_type),
           size_bytes = COALESCE($7, size_bytes),
           content_hash = COALESCE($8, content_hash),
           artefact_id = COALESCE($9, artefact_id),
           version = COALESCE($10, version),
           revision = revision + 1,
           updated_at = $11
         WHERE id = $1 AND tenant_id = $2 AND revision = $3 AND deleted_at IS NULL
         RETURNING *`,
        [
          id,
          scoped.tenantId,
          patch.expectedRevision,
          patch.path ?? null,
          patch.displayName ?? null,
          patch.mimeType ?? null,
          patch.sizeBytes ?? null,
          patch.contentHash ?? null,
          patch.artefactId ?? null,
          patch.version ?? null,
          now,
        ],
      );
      if (!result.rows[0]) {
        const existing = await files.get(actor, id);
        if (!existing) {
          throw new OwnershipError(`Fail-closed: file ${id} is not visible to tenant ${scoped.tenantId}.`);
        }
        throw new ConflictError(`File ${id} revision ${patch.expectedRevision} does not match ${existing.revision}.`);
      }
      return mapFile(sqlRow(result.rows[0]));
    },
    async logicalDelete(actor, id) {
      const scoped = assertActor(actor, 'delete file');
      const now = clock();
      const result = await tx.query<FileRow>(
        `UPDATE files SET status = 'deleted', deleted_at = $3, updated_at = $3, revision = revision + 1
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         RETURNING *`,
        [id, scoped.tenantId, now],
      );
      if (!result.rows[0]) {
        logPlatform('ownership.rejected', { action: 'delete file', tenantId: scoped.tenantId, fileId: id });
        throw new OwnershipError(`Fail-closed: file ${id} is not visible to tenant ${scoped.tenantId}.`);
      }
      return mapFile(sqlRow(result.rows[0]));
    },
  };

  const fileVersions: FileVersionStore = {
    async append(actor, row) {
      const scoped = assertActor(actor, 'append file version');
      const inserted = await tx.query<FileVersionRow>(
        `INSERT INTO file_versions (id, file_id, tenant_id, workspace_id, version, content_hash, mime_type, size_bytes, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          row.id,
          row.fileId,
          scoped.tenantId,
          row.workspaceId,
          row.version,
          row.contentHash,
          row.mimeType,
          row.sizeBytes,
          row.createdAt ?? clock(),
        ],
      );
      return mapFileVersion(sqlRow(inserted.rows[0]!));
    },
    async list(actor, fileId) {
      const scoped = assertActor(actor, 'list file versions');
      const result = await tx.query<FileVersionRow>(
        `SELECT * FROM file_versions WHERE tenant_id = $1 AND file_id = $2 ORDER BY version`,
        [scoped.tenantId, fileId],
      );
      return result.rows.map((row) => mapFileVersion(sqlRow(row)));
    },
  };

  const extractions: ExtractionStore = {
    async record(actor, row) {
      const scoped = assertActor(actor, 'record extraction');
      const now = clock();
      const inserted = await tx.query<ExtractionRow>(
        `INSERT INTO extractions (
           id, tenant_id, workspace_id, file_id, content_hash, extractor, extractor_version, status,
           page_count, structure, text_hash, error, job_id, created_at, updated_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14,$14)
         ON CONFLICT (tenant_id, content_hash, extractor, extractor_version) DO UPDATE SET
           status = EXCLUDED.status,
           page_count = EXCLUDED.page_count,
           structure = EXCLUDED.structure,
           text_hash = EXCLUDED.text_hash,
           error = EXCLUDED.error,
           job_id = COALESCE(EXCLUDED.job_id, extractions.job_id),
           file_id = COALESCE(EXCLUDED.file_id, extractions.file_id),
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          row.id,
          scoped.tenantId,
          row.workspaceId,
          row.fileId,
          row.contentHash,
          row.extractor,
          row.extractorVersion,
          row.status,
          row.pageCount,
          JSON.stringify(row.structure ?? {}),
          row.textHash,
          row.error ? JSON.stringify(row.error) : null,
          row.jobId,
          row.createdAt ?? now,
        ],
      );
      return mapExtraction(sqlRow(inserted.rows[0]!));
    },
    async getByHash(actor, contentHash, extractor, extractorVersion) {
      const scoped = assertActor(actor, 'read extraction');
      const result = await tx.query<ExtractionRow>(
        `SELECT * FROM extractions
         WHERE tenant_id = $1 AND content_hash = $2 AND extractor = $3 AND extractor_version = $4`,
        [scoped.tenantId, contentHash, extractor, extractorVersion],
      );
      const row = result.rows[0];
      if (!row) return null;
      if (scoped.workspaceId && row.workspace_id !== scoped.workspaceId) return null;
      return mapExtraction(sqlRow(row));
    },
    async get(actor, id) {
      const scoped = assertActor(actor, 'read extraction');
      const result = await tx.query<ExtractionRow>(
        'SELECT * FROM extractions WHERE id = $1 AND tenant_id = $2',
        [id, scoped.tenantId],
      );
      return result.rows[0] ? mapExtraction(sqlRow(result.rows[0])) : null;
    },
  };

  const chunks: ChunkStore = {
    async replaceForHash(actor, input) {
      const scoped = assertActor(actor, 'replace chunks');
      await tx.query(
        `DELETE FROM chunks
         WHERE tenant_id = $1 AND file_id = $2 AND chunker = $3 AND chunker_version = $4`,
        [scoped.tenantId, input.fileId, input.chunker, input.chunkerVersion],
      );
      const now = clock();
      const saved: ChunkRecord[] = [];
      for (const chunk of input.chunks) {
        const id = chunk.id ?? `chk_${randomUUID()}`;
        const inserted = await tx.query<ChunkRow>(
          `INSERT INTO chunks (
             id, tenant_id, workspace_id, file_id, content_hash, chunker, chunker_version, ordinal,
             start_offset, end_offset, locator, text, token_count, created_at
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)
           RETURNING *`,
          [
            id,
            scoped.tenantId,
            input.workspaceId,
            input.fileId,
            input.contentHash,
            input.chunker,
            input.chunkerVersion,
            chunk.ordinal,
            chunk.startOffset,
            chunk.endOffset,
            JSON.stringify(chunk.locator),
            chunk.text,
            chunk.tokenCount,
            now,
          ],
        );
        saved.push(mapChunk(sqlRow(inserted.rows[0]!)));
      }
      return saved;
    },
    async listForFile(actor, fileId) {
      const scoped = assertActor(actor, 'list chunks');
      const result = await tx.query<ChunkRow>(
        `SELECT * FROM chunks WHERE tenant_id = $1 AND file_id = $2 ORDER BY ordinal`,
        [scoped.tenantId, fileId],
      );
      return result.rows
        .map((row) => mapChunk(sqlRow(row)))
        .filter((row) => !scoped.workspaceId || row.workspaceId === scoped.workspaceId);
    },
    async listForHash(actor, contentHash, chunker, chunkerVersion) {
      const scoped = assertActor(actor, 'list chunks by hash');
      const result = await tx.query<ChunkRow>(
        `SELECT * FROM chunks
         WHERE tenant_id = $1 AND content_hash = $2 AND chunker = $3 AND chunker_version = $4
         ORDER BY ordinal`,
        [scoped.tenantId, contentHash, chunker, chunkerVersion],
      );
      return result.rows.map((row) => mapChunk(sqlRow(row)));
    },
    async search(actor, workspaceId, query, limit = 20) {
      const scoped = assertActor(actor, 'search chunks');
      if (scoped.workspaceId && scoped.workspaceId !== workspaceId) return [];
      const result = await tx.query<ChunkRow & { rank: number }>(
        `SELECT *, ts_rank(tsv, plainto_tsquery('simple', $3)) AS rank
         FROM chunks
         WHERE tenant_id = $1 AND workspace_id = $2 AND tsv @@ plainto_tsquery('simple', $3)
         ORDER BY rank DESC, ordinal ASC
         LIMIT $4`,
        [scoped.tenantId, workspaceId, query, limit],
      );
      if (result.rows.length > 0) {
        return result.rows.map((row) => ({ ...mapChunk(sqlRow(row)), rank: Number(row.rank) }));
      }
      const fallback = await tx.query<ChunkRow>(
        `SELECT * FROM chunks
         WHERE tenant_id = $1 AND workspace_id = $2 AND text ILIKE $3
         ORDER BY ordinal
         LIMIT $4`,
        [scoped.tenantId, workspaceId, `%${query.replace(/[%_]/g, '\\$&')}%`, limit],
      );
      return fallback.rows.map((row) => ({ ...mapChunk(sqlRow(row)), rank: 0.1 }));
    },
    async get(actor, id) {
      const scoped = assertActor(actor, 'read chunk');
      const result = await tx.query<ChunkRow>('SELECT * FROM chunks WHERE id = $1 AND tenant_id = $2', [
        id,
        scoped.tenantId,
      ]);
      const mapped = result.rows[0] ? mapChunk(sqlRow(result.rows[0])) : null;
      if (!mapped) return null;
      if (scoped.workspaceId && mapped.workspaceId !== scoped.workspaceId) return null;
      return mapped;
    },
  };

  const attachments: AttachmentStore = {
    async attach(actor, input) {
      const scoped = assertActor(actor, 'attach file');
      const now = clock();
      const id = input.id ?? `att_${randomUUID()}`;
      const existing = await tx.query<AttachmentRow>(
        `SELECT * FROM attachments
         WHERE tenant_id = $1 AND conversation_id = $2 AND file_id = $3 AND detached_at IS NULL`,
        [scoped.tenantId, input.conversationId, input.fileId],
      );
      if (existing.rows[0]) return mapAttachment(sqlRow(existing.rows[0]));
      const inserted = await tx.query<AttachmentRow>(
        `INSERT INTO attachments (
           id, tenant_id, workspace_id, conversation_id, message_id, file_id, content_hash, created_at, detached_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL)
         RETURNING *`,
        [
          id,
          scoped.tenantId,
          input.workspaceId ?? scoped.workspaceId ?? null,
          input.conversationId,
          input.messageId,
          input.fileId,
          input.contentHash,
          now,
        ],
      );
      return mapAttachment(sqlRow(inserted.rows[0]!));
    },
    async detach(actor, id) {
      const scoped = assertActor(actor, 'detach file');
      const now = clock();
      const result = await tx.query<AttachmentRow>(
        `UPDATE attachments SET detached_at = $3
         WHERE id = $1 AND tenant_id = $2 AND detached_at IS NULL
         RETURNING *`,
        [id, scoped.tenantId, now],
      );
      if (!result.rows[0]) {
        throw new OwnershipError(`Fail-closed: attachment ${id} is not visible to tenant ${scoped.tenantId}.`);
      }
      return mapAttachment(sqlRow(result.rows[0]));
    },
    async listByConversation(actor, conversationId, opts) {
      const scoped = assertActor(actor, 'list attachments');
      const result = opts?.includeDetached
        ? await tx.query<AttachmentRow>(
            `SELECT * FROM attachments WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY created_at`,
            [scoped.tenantId, conversationId],
          )
        : await tx.query<AttachmentRow>(
            `SELECT * FROM attachments
             WHERE tenant_id = $1 AND conversation_id = $2 AND detached_at IS NULL
             ORDER BY created_at`,
            [scoped.tenantId, conversationId],
          );
      return result.rows.map((row) => mapAttachment(sqlRow(row)));
    },
    async get(actor, id) {
      const scoped = assertActor(actor, 'read attachment');
      const result = await tx.query<AttachmentRow>(
        'SELECT * FROM attachments WHERE id = $1 AND tenant_id = $2',
        [id, scoped.tenantId],
      );
      return result.rows[0] ? mapAttachment(sqlRow(result.rows[0])) : null;
    },
  };

  const casRefs: CasRefStore = {
    async ensureObject(sha256, sizeBytes) {
      const now = clock();
      const inserted = await tx.query<{ sha256: string; size_bytes: string | number; created_at: Date | string }>(
        `INSERT INTO cas_objects (sha256, size_bytes, created_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (sha256) DO UPDATE SET size_bytes = cas_objects.size_bytes
         RETURNING *`,
        [sha256, sizeBytes, now],
      );
      const row = inserted.rows[0]!;
      const count = await casRefs.refCount(sha256);
      return { sha256: row.sha256, sizeBytes: Number(row.size_bytes), createdAt: isoRequired(row.created_at), refCount: count };
    },
    async getObject(sha256) {
      const result = await tx.query<{ sha256: string; size_bytes: string | number; created_at: Date | string }>(
        'SELECT sha256, size_bytes, created_at FROM cas_objects WHERE sha256 = $1',
        [sha256],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        sha256: row.sha256,
        sizeBytes: Number(row.size_bytes),
        createdAt: isoRequired(row.created_at),
        refCount: await casRefs.refCount(sha256),
      };
    },
    async addRef(actor, input) {
      const scoped = assertActor(actor, 'add CAS ref');
      const now = clock();
      const id = input.id ?? `cref_${randomUUID()}`;
      const inserted = await tx.query<{
        id: string;
        sha256: string;
        tenant_id: string;
        workspace_id: string | null;
        kind: string;
        owner_id: string;
        created_at: Date | string;
      }>(
        `INSERT INTO cas_refs (id, sha256, tenant_id, workspace_id, kind, owner_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (sha256, kind, owner_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
         RETURNING *`,
        [id, input.sha256, scoped.tenantId, input.workspaceId, input.kind, input.ownerId, now],
      );
      const row = inserted.rows[0]!;
      return {
        id: row.id,
        sha256: row.sha256,
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id,
        kind: row.kind as CasRefKind,
        ownerId: row.owner_id,
        createdAt: isoRequired(row.created_at),
      };
    },
    async removeRef(actor, kind, ownerId, sha256) {
      const scoped = assertActor(actor, 'remove CAS ref');
      await tx.query(
        `DELETE FROM cas_refs WHERE tenant_id = $1 AND kind = $2 AND owner_id = $3 AND sha256 = $4`,
        [scoped.tenantId, kind, ownerId, sha256],
      );
    },
    async removeRefsByOwner(actor, ownerId, kind) {
      const scoped = assertActor(actor, 'remove CAS refs by owner');
      const result = kind
        ? await tx.query(
            `DELETE FROM cas_refs WHERE tenant_id = $1 AND owner_id = $2 AND kind = $3`,
            [scoped.tenantId, ownerId, kind],
          )
        : await tx.query(`DELETE FROM cas_refs WHERE tenant_id = $1 AND owner_id = $2`, [
            scoped.tenantId,
            ownerId,
          ]);
      return result.rowCount ?? 0;
    },
    async listRefsByOwner(actor, ownerId) {
      const scoped = assertActor(actor, 'list CAS refs by owner');
      const result = await tx.query<{
        id: string;
        sha256: string;
        tenant_id: string;
        workspace_id: string | null;
        kind: string;
        owner_id: string;
        created_at: Date | string;
      }>(`SELECT * FROM cas_refs WHERE tenant_id = $1 AND owner_id = $2 ORDER BY created_at`, [
        scoped.tenantId,
        ownerId,
      ]);
      return result.rows.map((row) => ({
        id: row.id,
        sha256: row.sha256,
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id,
        kind: row.kind as CasRefKind,
        ownerId: row.owner_id,
        createdAt: isoRequired(row.created_at),
      }));
    },
    async refCount(sha256) {
      const result = await tx.query<{ n: string | number }>(
        'SELECT COUNT(*)::int AS n FROM cas_refs WHERE sha256 = $1',
        [sha256],
      );
      return Number(result.rows[0]?.n ?? 0);
    },
    async hasTenantAccess(actor, sha256) {
      const scoped = assertActor(actor, 'CAS access');
      const result = await tx.query(
        'SELECT 1 FROM cas_refs WHERE sha256 = $1 AND tenant_id = $2 LIMIT 1',
        [sha256, scoped.tenantId],
      );
      return Boolean(result.rows[0]);
    },
    async listUnreferenced(limit = 100) {
      const result = await tx.query<{ sha256: string; size_bytes: string | number; created_at: Date | string }>(
        `SELECT o.sha256, o.size_bytes, o.created_at
         FROM cas_objects o
         LEFT JOIN cas_refs r ON r.sha256 = o.sha256
         WHERE r.id IS NULL
         ORDER BY o.created_at
         LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => ({
        sha256: row.sha256,
        sizeBytes: Number(row.size_bytes),
        createdAt: isoRequired(row.created_at),
        refCount: 0,
      }));
    },
    async deleteObject(sha256) {
      const count = await casRefs.refCount(sha256);
      if (count > 0) {
        throw new ConflictError(`Cannot GC CAS object ${sha256} while ${count} refs remain.`);
      }
      await tx.query('DELETE FROM cas_objects WHERE sha256 = $1', [sha256]);
    },
    async stats(): Promise<CasCatalogStats> {
      const catalog = await tx.query<{ object_count: string | number; catalog_bytes: string | number }>(
        `SELECT COUNT(*)::int AS object_count, COALESCE(SUM(size_bytes), 0)::bigint AS catalog_bytes
         FROM cas_objects`,
      );
      const unreferenced = await tx.query<{
        unreferenced_count: string | number;
        unreferenced_bytes: string | number;
      }>(
        `SELECT COUNT(*)::int AS unreferenced_count, COALESCE(SUM(o.size_bytes), 0)::bigint AS unreferenced_bytes
         FROM cas_objects o
         LEFT JOIN cas_refs r ON r.sha256 = o.sha256
         WHERE r.id IS NULL`,
      );
      return {
        objectCount: Number(catalog.rows[0]?.object_count ?? 0),
        catalogBytes: Number(catalog.rows[0]?.catalog_bytes ?? 0),
        unreferencedCount: Number(unreferenced.rows[0]?.unreferenced_count ?? 0),
        unreferencedBytes: Number(unreferenced.rows[0]?.unreferenced_bytes ?? 0),
      };
    },
  };

  return { files, fileVersions, extractions, chunks, attachments, casRefs };
}

interface FileRow {
  id: string;
  urn: string;
  tenant_id: string;
  workspace_id: string;
  path: string;
  display_name: string;
  mime_type: string;
  size_bytes: string | number;
  content_hash: string;
  status: string;
  artefact_id: string | null;
  created_by: string | null;
  revision: number | string;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
}

interface FileVersionRow {
  id: string;
  file_id: string;
  tenant_id: string;
  workspace_id: string;
  version: number | string;
  content_hash: string;
  mime_type: string;
  size_bytes: string | number;
  created_at: Date | string;
}

interface ExtractionRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  file_id: string | null;
  content_hash: string;
  extractor: string;
  extractor_version: string;
  status: string;
  page_count: number | string | null;
  structure: unknown;
  text_hash: string | null;
  error: unknown;
  job_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ChunkRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  file_id: string;
  content_hash: string;
  chunker: string;
  chunker_version: string;
  ordinal: number | string;
  start_offset: number | string;
  end_offset: number | string;
  locator: unknown;
  text: string;
  token_count: number | string;
  created_at: Date | string;
}

interface AttachmentRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  conversation_id: string;
  message_id: string | null;
  file_id: string;
  content_hash: string;
  created_at: Date | string;
  detached_at: Date | string | null;
}

export type { CasObjectRecord };
