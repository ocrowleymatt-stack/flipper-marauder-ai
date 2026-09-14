import { randomUUID } from 'node:crypto';
import { assertActor, sameWorkspace, type PersistenceActor } from '../actor.ts';
import { ConflictError, OwnershipError } from '../errors.ts';
import type {
  AttachmentRecord,
  AttachmentStore,
  CasCatalogStats,
  CasObjectRecord,
  CasRefKind,
  CasRefRecord,
  CasRefStore,
  ChunkRecord,
  ChunkStore,
  ExtractionRecord,
  ExtractionStore,
  FileRecord,
  FileStore,
  FileVersionRecord,
  FileVersionStore,
} from '../file-types.ts';

function lexicalRank(text: string, query: string): number {
  const hay = text.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  let hits = 0;
  for (const term of terms) {
    if (hay.includes(term)) hits += 1;
  }
  return hits / terms.length;
}

export function createMemoryFileStores(clock: () => string) {
  const files = new Map<string, FileRecord>();
  const versions = new Map<string, FileVersionRecord[]>();
  const extractions = new Map<string, ExtractionRecord>();
  const chunks = new Map<string, ChunkRecord>();
  const attachments = new Map<string, AttachmentRecord>();
  const casObjects = new Map<string, CasObjectRecord>();
  const casRefs = new Map<string, CasRefRecord>();

  const fileStore: FileStore = {
    async create(actor, input) {
      const scoped = assertActor(actor, 'create file');
      const now = clock();
      const record: FileRecord = {
        id: input.id,
        urn: input.urn ?? `urn:atlas:file:${input.id}`,
        tenantId: scoped.tenantId,
        workspaceId: input.workspaceId,
        path: input.path,
        displayName: input.displayName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        contentHash: input.contentHash,
        status: input.status ?? 'active',
        artefactId: input.artefactId ?? null,
        createdBy: input.createdBy ?? scoped.principalId ?? null,
        revision: input.revision ?? 1,
        version: input.version ?? 1,
        createdAt: input.createdAt ?? now,
        updatedAt: now,
        deletedAt: null,
      };
      files.set(record.id, record);
      return record;
    },
    async get(actor, id) {
      const scoped = assertActor(actor, 'read file');
      const record = files.get(id);
      if (!record || record.tenantId !== scoped.tenantId) return null;
      if (!sameWorkspace(scoped, record.workspaceId)) return null;
      return record;
    },
    async getByPath(actor, workspaceId, path) {
      const scoped = assertActor(actor, 'read file by path');
      if (!sameWorkspace(scoped, workspaceId)) return null;
      return (
        [...files.values()].find(
          (item) =>
            item.tenantId === scoped.tenantId &&
            item.workspaceId === workspaceId &&
            item.path === path &&
            !item.deletedAt,
        ) ?? null
      );
    },
    async list(actor, workspaceId, opts) {
      const scoped = assertActor(actor, 'list files');
      if (!sameWorkspace(scoped, workspaceId)) return [];
      return [...files.values()]
        .filter((item) => item.tenantId === scoped.tenantId && item.workspaceId === workspaceId)
        .filter((item) => opts?.includeDeleted || !item.deletedAt)
        .sort((a, b) => a.path.localeCompare(b.path));
    },
    async update(actor, id, patch) {
      const scoped = assertActor(actor, 'update file');
      const existing = await fileStore.get(actor, id);
      if (!existing || existing.deletedAt) {
        throw new OwnershipError(`Fail-closed: file ${id} is not visible to tenant ${scoped.tenantId}.`);
      }
      if (existing.revision !== patch.expectedRevision) {
        throw new ConflictError(`File ${id} revision ${patch.expectedRevision} does not match ${existing.revision}.`);
      }
      const next: FileRecord = {
        ...existing,
        path: patch.path ?? existing.path,
        displayName: patch.displayName ?? existing.displayName,
        mimeType: patch.mimeType ?? existing.mimeType,
        sizeBytes: patch.sizeBytes ?? existing.sizeBytes,
        contentHash: patch.contentHash ?? existing.contentHash,
        artefactId: patch.artefactId ?? existing.artefactId,
        version: patch.version ?? existing.version,
        revision: existing.revision + 1,
        updatedAt: clock(),
      };
      files.set(id, next);
      return next;
    },
    async logicalDelete(actor, id) {
      const scoped = assertActor(actor, 'delete file');
      const existing = await fileStore.get(actor, id);
      if (!existing || existing.deletedAt) {
        throw new OwnershipError(`Fail-closed: file ${id} is not visible to tenant ${scoped.tenantId}.`);
      }
      const next: FileRecord = {
        ...existing,
        status: 'deleted',
        deletedAt: clock(),
        revision: existing.revision + 1,
        updatedAt: clock(),
      };
      files.set(id, next);
      return next;
    },
  };

  const fileVersions: FileVersionStore = {
    async append(actor, row) {
      const scoped = assertActor(actor, 'append file version');
      const record: FileVersionRecord = {
        id: row.id,
        fileId: row.fileId,
        tenantId: scoped.tenantId,
        workspaceId: row.workspaceId,
        version: row.version,
        contentHash: row.contentHash,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        createdAt: row.createdAt ?? clock(),
      };
      const list = versions.get(row.fileId) ?? [];
      list.push(record);
      versions.set(row.fileId, list);
      return record;
    },
    async list(actor, fileId) {
      const scoped = assertActor(actor, 'list file versions');
      return (versions.get(fileId) ?? []).filter((item) => item.tenantId === scoped.tenantId);
    },
  };

  const extractionStore: ExtractionStore = {
    async record(actor, row) {
      const scoped = assertActor(actor, 'record extraction');
      const key = `${scoped.tenantId}::${row.contentHash}::${row.extractor}::${row.extractorVersion}`;
      const now = clock();
      const record: ExtractionRecord = {
        ...row,
        tenantId: scoped.tenantId,
        createdAt: row.createdAt ?? extractions.get(key)?.createdAt ?? now,
        updatedAt: now,
      };
      extractions.set(key, record);
      return record;
    },
    async getByHash(actor, contentHash, extractor, extractorVersion) {
      const scoped = assertActor(actor, 'read extraction');
      const record = extractions.get(`${scoped.tenantId}::${contentHash}::${extractor}::${extractorVersion}`);
      if (!record) return null;
      if (!sameWorkspace(scoped, record.workspaceId)) return null;
      return record;
    },
    async get(actor, id) {
      const scoped = assertActor(actor, 'read extraction');
      return [...extractions.values()].find((item) => item.id === id && item.tenantId === scoped.tenantId) ?? null;
    },
  };

  const chunkStore: ChunkStore = {
    async replaceForHash(actor, input) {
      const scoped = assertActor(actor, 'replace chunks');
      for (const [id, chunk] of [...chunks]) {
        if (
          chunk.tenantId === scoped.tenantId &&
          chunk.fileId === input.fileId &&
          chunk.chunker === input.chunker &&
          chunk.chunkerVersion === input.chunkerVersion
        ) {
          chunks.delete(id);
        }
      }
      const now = clock();
      const saved: ChunkRecord[] = [];
      for (const chunk of input.chunks) {
        const record: ChunkRecord = {
          id: chunk.id ?? `chk_${randomUUID()}`,
          tenantId: scoped.tenantId,
          workspaceId: input.workspaceId,
          fileId: input.fileId,
          contentHash: input.contentHash,
          chunker: input.chunker,
          chunkerVersion: input.chunkerVersion,
          ordinal: chunk.ordinal,
          startOffset: chunk.startOffset,
          endOffset: chunk.endOffset,
          locator: chunk.locator,
          text: chunk.text,
          tokenCount: chunk.tokenCount,
          createdAt: now,
        };
        chunks.set(record.id, record);
        saved.push(record);
      }
      return saved;
    },
    async listForFile(actor, fileId) {
      const scoped = assertActor(actor, 'list chunks');
      return [...chunks.values()]
        .filter((item) => item.tenantId === scoped.tenantId && item.fileId === fileId)
        .filter((item) => sameWorkspace(scoped, item.workspaceId))
        .sort((a, b) => a.ordinal - b.ordinal);
    },
    async listForHash(actor, contentHash, chunker, chunkerVersion) {
      const scoped = assertActor(actor, 'list chunks by hash');
      return [...chunks.values()]
        .filter(
          (item) =>
            item.tenantId === scoped.tenantId &&
            item.contentHash === contentHash &&
            item.chunker === chunker &&
            item.chunkerVersion === chunkerVersion,
        )
        .sort((a, b) => a.ordinal - b.ordinal);
    },
    async search(actor, workspaceId, query, limit = 20) {
      const scoped = assertActor(actor, 'search chunks');
      if (!sameWorkspace(scoped, workspaceId)) return [];
      return [...chunks.values()]
        .filter((item) => item.tenantId === scoped.tenantId && item.workspaceId === workspaceId)
        .map((item) => ({ ...item, rank: lexicalRank(item.text, query) }))
        .filter((item) => item.rank > 0)
        .sort((a, b) => b.rank - a.rank || a.ordinal - b.ordinal)
        .slice(0, limit);
    },
    async get(actor, id) {
      const scoped = assertActor(actor, 'read chunk');
      const record = chunks.get(id);
      if (!record || record.tenantId !== scoped.tenantId) return null;
      if (!sameWorkspace(scoped, record.workspaceId)) return null;
      return record;
    },
  };

  const attachmentStore: AttachmentStore = {
    async attach(actor, input) {
      const scoped = assertActor(actor, 'attach file');
      const existing = [...attachments.values()].find(
        (item) =>
          item.tenantId === scoped.tenantId &&
          item.conversationId === input.conversationId &&
          item.fileId === input.fileId &&
          !item.detachedAt,
      );
      if (existing) return existing;
      const record: AttachmentRecord = {
        id: input.id ?? `att_${randomUUID()}`,
        tenantId: scoped.tenantId,
        workspaceId: input.workspaceId ?? scoped.workspaceId ?? null,
        conversationId: input.conversationId,
        messageId: input.messageId,
        fileId: input.fileId,
        contentHash: input.contentHash,
        createdAt: clock(),
        detachedAt: null,
      };
      attachments.set(record.id, record);
      return record;
    },
    async detach(actor, id) {
      const scoped = assertActor(actor, 'detach file');
      const existing = attachments.get(id);
      if (!existing || existing.tenantId !== scoped.tenantId) {
        throw new OwnershipError(`Fail-closed: attachment ${id} is not visible to tenant ${scoped.tenantId}.`);
      }
      const next = { ...existing, detachedAt: clock() };
      attachments.set(id, next);
      return next;
    },
    async listByConversation(actor, conversationId, opts) {
      const scoped = assertActor(actor, 'list attachments');
      return [...attachments.values()]
        .filter((item) => item.tenantId === scoped.tenantId && item.conversationId === conversationId)
        .filter((item) => opts?.includeDetached || !item.detachedAt);
    },
    async get(actor, id) {
      const scoped = assertActor(actor, 'read attachment');
      const record = attachments.get(id);
      if (!record || record.tenantId !== scoped.tenantId) return null;
      return record;
    },
  };

  const casRefStore: CasRefStore = {
    async ensureObject(sha256, sizeBytes) {
      const existing = casObjects.get(sha256);
      if (existing) return { ...existing, refCount: await casRefStore.refCount(sha256) };
      const record: CasObjectRecord = { sha256, sizeBytes, createdAt: clock(), refCount: 0 };
      casObjects.set(sha256, record);
      return record;
    },
    async getObject(sha256) {
      const existing = casObjects.get(sha256);
      if (!existing) return null;
      return { ...existing, refCount: await casRefStore.refCount(sha256) };
    },
    async addRef(actor, input) {
      const scoped = assertActor(actor, 'add CAS ref');
      const key = `${input.sha256}::${input.kind}::${input.ownerId}`;
      const existing = casRefs.get(key);
      if (existing) return existing;
      const record: CasRefRecord = {
        id: input.id ?? `cref_${randomUUID()}`,
        sha256: input.sha256,
        tenantId: scoped.tenantId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        ownerId: input.ownerId,
        createdAt: clock(),
      };
      casRefs.set(key, record);
      return record;
    },
    async removeRef(actor, kind, ownerId, sha256) {
      const scoped = assertActor(actor, 'remove CAS ref');
      const key = `${sha256}::${kind}::${ownerId}`;
      const existing = casRefs.get(key);
      if (existing && existing.tenantId === scoped.tenantId) casRefs.delete(key);
    },
    async removeRefsByOwner(actor, ownerId, kind) {
      const scoped = assertActor(actor, 'remove CAS refs by owner');
      let removed = 0;
      for (const [key, ref] of [...casRefs]) {
        if (ref.tenantId !== scoped.tenantId || ref.ownerId !== ownerId) continue;
        if (kind && ref.kind !== kind) continue;
        casRefs.delete(key);
        removed += 1;
      }
      return removed;
    },
    async listRefsByOwner(actor, ownerId) {
      const scoped = assertActor(actor, 'list CAS refs by owner');
      return [...casRefs.values()].filter(
        (item) => item.tenantId === scoped.tenantId && item.ownerId === ownerId,
      );
    },
    async refCount(sha256) {
      return [...casRefs.values()].filter((item) => item.sha256 === sha256).length;
    },
    async hasTenantAccess(actor, sha256) {
      const scoped = assertActor(actor, 'CAS access');
      return [...casRefs.values()].some((item) => item.sha256 === sha256 && item.tenantId === scoped.tenantId);
    },
    async listUnreferenced(limit = 100) {
      return [...casObjects.values()]
        .map((item) => ({ ...item, refCount: [...casRefs.values()].filter((ref) => ref.sha256 === item.sha256).length }))
        .filter((item) => item.refCount === 0)
        .slice(0, limit);
    },
    async deleteObject(sha256) {
      const count = await casRefStore.refCount(sha256);
      if (count > 0) throw new ConflictError(`Cannot GC CAS object ${sha256} while ${count} refs remain.`);
      casObjects.delete(sha256);
    },
    async stats(): Promise<CasCatalogStats> {
      const objects = [...casObjects.values()];
      const unreferenced = objects.filter(
        (item) => ![...casRefs.values()].some((ref) => ref.sha256 === item.sha256),
      );
      return {
        objectCount: objects.length,
        catalogBytes: objects.reduce((sum, item) => sum + item.sizeBytes, 0),
        unreferencedCount: unreferenced.length,
        unreferencedBytes: unreferenced.reduce((sum, item) => sum + item.sizeBytes, 0),
      };
    },
  };

  return {
    files: fileStore,
    fileVersions,
    extractions: extractionStore,
    chunks: chunkStore,
    attachments: attachmentStore,
    casRefs: casRefStore,
  };
}

export type MemoryFileStores = ReturnType<typeof createMemoryFileStores>;
export type { CasRefKind };
