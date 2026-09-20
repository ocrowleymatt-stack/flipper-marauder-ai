import { randomUUID } from 'node:crypto';
import type { ProvenanceRecord } from '@atlas-vnext/contracts';
import { logPlatform } from '@atlas-vnext/observability';
import type { PersistenceActor, PlatformPersistence, FileRecord, ArtefactMetadata } from '@atlas-vnext/persistence';
import { OwnershipError } from '@atlas-vnext/persistence';
import type { CasStore } from '@atlas-vnext/storage';
import { CasNotFoundError, sha256Hex } from '@atlas-vnext/storage';
import { CHUNKER_ID, CHUNKER_VERSION, chunkBlocks } from './chunk.ts';
import { CasMissingError, FilesAccessError, IngestionError } from './errors.ts';
import { EXTRACTOR_ID, EXTRACTOR_VERSION, extractBytes, estimateTokens } from './extract/index.ts';
import { resolveMime, sniffMime, type AllowedMime } from './mime.ts';
import { originFromProvenance, type FileOrigin } from './origin.ts';
import { displayNameFromPath, isAcquisitionStoredPath, sanitiseRelPath } from './path.ts';
import {
  DEFAULT_SITE_RETENTION,
  SiteService,
  STORAGE_JOB_GC,
  STORAGE_JOB_RETAIN,
  type SiteRetentionPolicy,
} from './sites.ts';

export const FILE_JOB_DUNGEON = 'platform';
export const FILE_JOB_INGEST = 'files.ingest';
export { STORAGE_JOB_DUNGEON, STORAGE_JOB_GC, STORAGE_JOB_RETAIN } from './sites.ts';

export { originFromProvenance } from './origin.ts';
export type { FileOrigin } from './origin.ts';
export type FilesJobOutcome =
  | FileRecord
  | { kind: 'storage.retain'; expiredRevisionIds: string[] }
  | { kind: 'storage.gc'; reclaimed: string[] };

export interface IngestInput {
  projectId: string;
  path: string;
  bytes: Uint8Array;
  declaredMime?: string | null;
  messageId?: string | null;
}

export class FilesService {
  readonly sites: SiteService;

  constructor(
    private readonly persistence: PlatformPersistence,
    private readonly cas: CasStore,
    private readonly clock: () => string = () => new Date().toISOString(),
    policy: SiteRetentionPolicy = DEFAULT_SITE_RETENTION,
  ) {
    this.sites = new SiteService(persistence, cas, clock, policy);
  }

  async ingest(actor: PersistenceActor, input: IngestInput): Promise<FileRecord> {
    const scoped = this.scoped(actor, 'ingest file');
    const path = sanitiseRelPath(input.path);
    this.refuseOrdinaryAcquisitionWrite(path);
    const mime = resolveMime({ bytes: input.bytes, filename: path, declared: input.declaredMime });
    return this.storeOriginal(scoped, input, path, mime, true);
  }

  /** Preserve opaque archive bytes in shared CAS without scheduling extraction. */
  async ingestRawOriginal(actor: PersistenceActor, input: IngestInput): Promise<FileRecord> {
    const scoped = this.scoped(actor, 'ingest raw original');
    const path = sanitiseRelPath(input.path);
    this.refuseOrdinaryAcquisitionWrite(path);
    const mime = sniffMime(input.bytes) === 'application/zip' ? 'application/zip' : 'application/octet-stream';
    return this.storeOriginal(scoped, input, path, mime, false);
  }

  /**
   * Privileged writer for the reserved `acquisition/` namespace.
   * Creates a new path only; never updates an existing acquisition original or manifest.
   */
  async ingestAcquisitionOriginal(
    actor: PersistenceActor,
    input: IngestInput,
    extract: boolean,
  ): Promise<FileRecord> {
    const scoped = this.scoped(actor, 'ingest acquisition original');
    const path = sanitiseRelPath(input.path);
    if (!isAcquisitionStoredPath(path)) {
      throw new IngestionError('Acquisition originals must be stored under the acquisition/ prefix.');
    }
    const mime = extract
      ? resolveMime({ bytes: input.bytes, filename: path, declared: input.declaredMime })
      : sniffMime(input.bytes) === 'application/zip'
        ? 'application/zip'
        : 'application/octet-stream';
    return this.storeOriginal(scoped, input, path, mime, extract);
  }

  private refuseOrdinaryAcquisitionWrite(path: string): void {
    if (isAcquisitionStoredPath(path)) {
      throw new IngestionError('The acquisition/ path prefix is reserved for append-only acquisition originals.');
    }
  }

  private async storeOriginal(scoped: PersistenceActor, input: IngestInput, path: string, mime: string, extract: boolean): Promise<FileRecord> {
    const workspace = await this.requireProject(scoped, input.projectId);
    logPlatform('files.ingest.start', {
      tenantId: scoped.tenantId,
      workspaceId: workspace.id,
      path,
      mimeType: mime,
      sizeBytes: input.bytes.byteLength,
    });
    const existingBeforePut = await this.persistence.forActor(scoped).files.getByPath(scoped, workspace.id, path);
    if (existingBeforePut && isAcquisitionStoredPath(path)) {
      throw new IngestionError('Acquisition originals are append-only and cannot be overwritten.');
    }
    const put = await this.cas.put(input.bytes);
    if (put.sha256 !== sha256Hex(input.bytes)) {
      throw new IngestionError('CAS hash verification failed after put.');
    }
    return this.persistence.run(async () => {
      const bound = this.persistence.forActor(scoped);
      await bound.casRefs.ensureObject(put.sha256, put.sizeBytes);
      const existing = await bound.files.getByPath(scoped, workspace.id, path);
      if (existing && isAcquisitionStoredPath(path)) {
        throw new IngestionError('Acquisition originals are append-only and cannot be overwritten.');
      }
      const artefact = await this.persistence.artefacts.record(scoped, {
        id: existing?.artefactId ?? `art_${randomUUID()}`,
        workspaceId: workspace.id,
        type: 'file',
        version: existing ? existing.version + 1 : 1,
        parentId: existing?.artefactId ?? null,
        contentHash: put.sha256,
        mimeType: mime,
        sizeBytes: put.sizeBytes,
      });
      let file: FileRecord;
      if (existing) {
        await bound.casRefs.removeRef(scoped, 'file', existing.id, existing.contentHash);
        file = await bound.files.update(scoped, existing.id, {
          expectedRevision: existing.revision,
          mimeType: mime,
          sizeBytes: put.sizeBytes,
          contentHash: put.sha256,
          artefactId: artefact.id,
          version: existing.version + 1,
          displayName: displayNameFromPath(path),
        });
      } else {
        file = await bound.files.create(scoped, {
          id: `fil_${randomUUID()}`,
          workspaceId: workspace.id,
          path,
          displayName: displayNameFromPath(path),
          mimeType: mime,
          sizeBytes: put.sizeBytes,
          contentHash: put.sha256,
          artefactId: artefact.id,
          createdBy: scoped.principalId ?? null,
        });
      }
      await bound.fileVersions.append(scoped, {
        id: `fver_${randomUUID()}`,
        fileId: file.id,
        workspaceId: workspace.id,
        version: file.version,
        contentHash: put.sha256,
        mimeType: mime,
        sizeBytes: put.sizeBytes,
      });
      await bound.casRefs.addRef(scoped, {
        sha256: put.sha256,
        workspaceId: workspace.id,
        kind: 'file',
        ownerId: file.id,
      });
      if (extract) await bound.jobs.enqueue(scoped, {
        dungeon: FILE_JOB_DUNGEON,
        type: FILE_JOB_INGEST,
        workspaceId: workspace.id,
        projectId: workspace.id,
        idempotencyKey: `files.ingest:${file.id}:${put.sha256}:${EXTRACTOR_VERSION}:${CHUNKER_VERSION}`,
        checkpoint: { fileId: file.id, contentHash: put.sha256, mimeType: mime, path },
      });
      await bound.provenance.record(this.fileProvenance(file, artefact, 'ingest'));
      logPlatform('files.ingest.committed', {
        tenantId: scoped.tenantId,
        workspaceId: workspace.id,
        fileId: file.id,
        contentHash: put.sha256,
        sizeBytes: put.sizeBytes,
        mimeType: mime,
        deduplicated: put.deduplicated,
      });
      return file;
    });
  }

  async readBytes(actor: PersistenceActor, fileId: string): Promise<Uint8Array> {
    const scoped = this.scoped(actor, 'read file bytes');
    const bound = this.persistence.forActor(scoped);
    const file = await bound.files.get(scoped, fileId);
    if (!file || file.deletedAt) {
      throw new FilesAccessError(`Fail-closed: file ${fileId} is not visible to this tenant.`);
    }
    const allowed = await bound.casRefs.hasTenantAccess(scoped, file.contentHash);
    if (!allowed) {
      throw new FilesAccessError('Fail-closed: content hash does not grant access without a tenant-owned ref.');
    }
    return this.readCas(file.contentHash);
  }

  async readByHash(actor: PersistenceActor, sha256: string): Promise<Uint8Array> {
    const scoped = this.scoped(actor, 'read CAS hash');
    const bound = this.persistence.forActor(scoped);
    const allowed = await bound.casRefs.hasTenantAccess(scoped, sha256);
    if (!allowed) {
      throw new FilesAccessError('Fail-closed: hash does not grant cross-tenant or unreferenced CAS access.');
    }
    return this.readCas(sha256);
  }

  /**
   * Observable metadata/object divergence. Never synthesises file bytes.
   */
  async inspectCas(
    actor: PersistenceActor,
    fileId: string,
  ): Promise<{ fileId: string; contentHash: string; metadata: true; object: 'ok' | 'missing' }> {
    const scoped = this.scoped(actor, 'inspect CAS');
    const bound = this.persistence.forActor(scoped);
    const file = await bound.files.get(scoped, fileId);
    if (!file || file.deletedAt) {
      throw new FilesAccessError(`Fail-closed: file ${fileId} is not visible to this tenant.`);
    }
    const present = await this.cas.has(file.contentHash);
    if (!present) {
      logPlatform(
        'cas.divergence',
        { tenantId: scoped.tenantId, fileId: file.id, contentHash: file.contentHash, object: 'missing' },
        'error',
      );
    }
    return { fileId: file.id, contentHash: file.contentHash, metadata: true, object: present ? 'ok' : 'missing' };
  }

  private async readCas(sha256: string): Promise<Uint8Array> {
    try {
      return await this.cas.get(sha256);
    } catch (err) {
      if (err instanceof CasNotFoundError) {
        logPlatform('cas.missing', { contentHash: sha256 }, 'error');
        throw new CasMissingError(sha256);
      }
      throw err;
    }
  }

  async logicalDelete(actor: PersistenceActor, fileId: string): Promise<FileRecord> {
    const scoped = this.scoped(actor, 'delete file');
    return this.persistence.run(async () => {
      const bound = this.persistence.forActor(scoped);
      const existing = await bound.files.get(scoped, fileId);
      if (existing && !existing.deletedAt && isAcquisitionStoredPath(existing.path)) {
        throw new IngestionError('Acquisition originals are append-only and cannot be deleted.');
      }
      const file = await bound.files.logicalDelete(scoped, fileId);
      await bound.casRefs.removeRef(scoped, 'file', file.id, file.contentHash);
      logPlatform('files.deleted', { tenantId: scoped.tenantId, fileId: file.id, contentHash: file.contentHash });
      return file;
    });
  }

  async gcUnreferenced(limit = 50): Promise<string[]> {
    const refs = this.persistence.forActor({ tenantId: 'system_gc' }).casRefs;
    const removed: string[] = [];
    const orphans = await refs.listUnreferenced(limit);
    for (const object of orphans) {
      try {
        const count = await refs.refCount(object.sha256);
        if (count > 0) {
          logPlatform('sites.gc.skipped', {
            contentHash: object.sha256,
            reason: 'still-referenced',
            refCount: count,
          });
          continue;
        }
        await refs.deleteObject(object.sha256);
        await this.cas.unlink(object.sha256);
        removed.push(object.sha256);
        logPlatform('sites.gc.reclaimed', { contentHash: object.sha256, sizeBytes: object.sizeBytes });
      } catch (err) {
        logPlatform(
          'sites.gc.failed',
          { contentHash: object.sha256, error: err instanceof Error ? err.message : String(err) },
          'error',
        );
      }
    }
    const disk = await this.cas.listObjects();
    for (const object of disk) {
      const catalog = await refs.getObject(object.sha256);
      if (catalog) continue;
      try {
        const liveRefs = await refs.refCount(object.sha256);
        if (liveRefs > 0) continue;
        await this.cas.unlink(object.sha256);
        removed.push(object.sha256);
        logPlatform('sites.gc.reclaimed', {
          contentHash: object.sha256,
          sizeBytes: object.sizeBytes,
          reason: 'disk-orphan',
        });
      } catch (err) {
        logPlatform(
          'sites.gc.failed',
          { contentHash: object.sha256, error: err instanceof Error ? err.message : String(err) },
          'error',
        );
      }
    }
    return removed;
  }

  async processNextJob(actor: PersistenceActor, workerId: string, leaseMs = 30_000): Promise<FilesJobOutcome | null> {
    const scoped = this.scoped(actor, 'process file job');
    const bound = this.persistence.forActor(scoped);
    const job = await bound.jobs.claimNext(scoped, workerId, leaseMs, {
      types: [FILE_JOB_INGEST, STORAGE_JOB_RETAIN, STORAGE_JOB_GC],
    });
    if (!job) return null;
    if (job.type === STORAGE_JOB_RETAIN) {
      try {
        const expiredRevisionIds = await this.sites.retainForTenant(scoped);
        await bound.jobs.checkpoint(scoped, job.id, 'retained', 1, { expiredRevisionIds });
        await bound.jobs.complete(scoped, job.id);
        return { kind: 'storage.retain', expiredRevisionIds };
      } catch (err) {
        await bound.jobs.fail(scoped, job.id, {
          code: 'storage.retain_failed',
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
        });
        throw err;
      }
    }
    if (job.type === STORAGE_JOB_GC) {
      try {
        const reclaimed = await this.gcUnreferenced();
        await bound.jobs.checkpoint(scoped, job.id, 'reclaimed', 1, { reclaimedCount: reclaimed.length });
        await bound.jobs.complete(scoped, job.id);
        logPlatform('sites.gc.completed', { tenantId: scoped.tenantId, reclaimedCount: reclaimed.length });
        return { kind: 'storage.gc', reclaimed };
      } catch (err) {
        await bound.jobs.fail(scoped, job.id, {
          code: 'storage.gc_failed',
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
        });
        logPlatform(
          'sites.gc.failed',
          { tenantId: scoped.tenantId, error: err instanceof Error ? err.message : String(err) },
          'error',
        );
        throw err;
      }
    }
    if (job.type !== FILE_JOB_INGEST) {
      await bound.jobs.fail(scoped, job.id, {
        code: 'unsupported_job',
        message: `Files worker does not handle ${job.type}`,
        retryable: false,
      });
      return null;
    }
    const fileId = String(job.checkpoint.fileId ?? '');
    try {
      const file = await this.extractAndChunk(scoped, fileId, job.id);
      await bound.jobs.checkpoint(scoped, job.id, 'chunked', 1, { fileId, contentHash: file.contentHash });
      await bound.jobs.complete(scoped, job.id);
      return file;
    } catch (err) {
      await bound.jobs.fail(scoped, job.id, {
        code: 'files.ingest_failed',
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      });
      throw err;
    }
  }

  async extractAndChunk(actor: PersistenceActor, fileId: string, jobId?: string): Promise<FileRecord> {
    const scoped = this.scoped(actor, 'extract file');
    const bound = this.persistence.forActor(scoped);
    const file = await bound.files.get(scoped, fileId);
    if (!file || file.deletedAt) throw new FilesAccessError(`File ${fileId} is not visible.`);
    const existingExtract = await bound.extractions.getByHash(scoped, file.contentHash, EXTRACTOR_ID, EXTRACTOR_VERSION);
    const existingChunks = await bound.chunks.listForHash(scoped, file.contentHash, CHUNKER_ID, CHUNKER_VERSION);
    const forThisFile = existingChunks.filter((chunk) => chunk.fileId === file.id);
    if (existingExtract?.status === 'succeeded' && forThisFile.length > 0) {
      logPlatform('files.extract.skipped', {
        tenantId: scoped.tenantId,
        fileId: file.id,
        contentHash: file.contentHash,
        reason: 'unchanged',
      });
      return file;
    }
    if (existingExtract?.status === 'succeeded' && existingChunks.length > 0 && forThisFile.length === 0) {
      await bound.chunks.replaceForHash(scoped, {
        fileId: file.id,
        workspaceId: file.workspaceId,
        contentHash: file.contentHash,
        chunker: CHUNKER_ID,
        chunkerVersion: CHUNKER_VERSION,
        chunks: existingChunks.map((chunk, ordinal) => ({
          ordinal,
          startOffset: chunk.startOffset,
          endOffset: chunk.endOffset,
          locator: { ...chunk.locator, path: file.path },
          text: chunk.text,
          tokenCount: chunk.tokenCount,
        })),
      });
      logPlatform('files.extract.skipped', {
        tenantId: scoped.tenantId,
        fileId: file.id,
        contentHash: file.contentHash,
        reason: 'cloned-from-hash',
      });
      return file;
    }
    const allowed = await bound.casRefs.hasTenantAccess(scoped, file.contentHash);
    if (!allowed) throw new FilesAccessError('Fail-closed: hash does not grant access.');
    const bytes = await this.cas.get(file.contentHash);
    const extracted = extractBytes(bytes, file.mimeType as AllowedMime, file.path);
    const textBytes = new TextEncoder().encode(extracted.text);
    const textPut = await this.cas.put(textBytes);
    await this.persistence.run(async () => {
      const inner = this.persistence.forActor(scoped);
      await inner.casRefs.ensureObject(textPut.sha256, textPut.sizeBytes);
      await inner.casRefs.addRef(scoped, {
        sha256: textPut.sha256,
        workspaceId: file.workspaceId,
        kind: 'extraction',
        ownerId: file.id,
      });
      await inner.extractions.record(scoped, {
        id: existingExtract?.id ?? `ext_${randomUUID()}`,
        workspaceId: file.workspaceId,
        fileId: file.id,
        contentHash: file.contentHash,
        extractor: EXTRACTOR_ID,
        extractorVersion: EXTRACTOR_VERSION,
        status: 'succeeded',
        pageCount: extracted.pageCount,
        structure: extracted.structure,
        textHash: textPut.sha256,
        error: null,
        jobId: jobId ?? null,
      });
      if (existingChunks.length === 0) {
        const prepared = chunkBlocks(extracted.blocks, file.path);
        await inner.chunks.replaceForHash(scoped, {
          fileId: file.id,
          workspaceId: file.workspaceId,
          contentHash: file.contentHash,
          chunker: CHUNKER_ID,
          chunkerVersion: CHUNKER_VERSION,
          chunks: prepared,
        });
      }
    });
    logPlatform('files.extract.completed', {
      tenantId: scoped.tenantId,
      fileId: file.id,
      contentHash: file.contentHash,
      pageCount: extracted.pageCount,
      tokenCount: estimateTokens(extracted.text),
    });
    return file;
  }

  async list(actor: PersistenceActor, projectId: string): Promise<FileRecord[]> {
    const scoped = this.scoped(actor, 'list files');
    await this.requireProject(scoped, projectId);
    return this.persistence.forActor(scoped).files.list(scoped, projectId);
  }

  async getMetadata(actor: PersistenceActor, fileId: string): Promise<FileRecord | null> {
    const scoped = this.scoped(actor, 'read file metadata');
    const file = await this.persistence.forActor(scoped).files.get(scoped, fileId);
    if (!file || file.deletedAt) return null;
    return file;
  }

  async originFor(actor: PersistenceActor, file: FileRecord): Promise<FileOrigin> {
    const scoped = this.scoped(actor, 'read file origin');
    if (!file.artefactId) return 'unknown';
    const entries = await this.persistence.forActor(scoped).provenance.forArtefact(file.artefactId);
    return originFromProvenance(entries);
  }

  async listAttachments(actor: PersistenceActor, conversationId: string) {
    const scoped = this.scoped(actor, 'list attachments');
    return this.persistence.forActor(scoped).attachments.listByConversation(scoped, conversationId);
  }

  async attachToConversation(
    actor: PersistenceActor,
    input: { conversationId: string; fileId: string; messageId?: string | null },
  ) {
    const scoped = this.scoped(actor, 'attach file');
    const bound = this.persistence.forActor(scoped);
    const conversation = await bound.conversations.get(input.conversationId);
    if (!conversation) throw new OwnershipError(`Fail-closed: conversation ${input.conversationId} is not visible.`);
    const file = await bound.files.get(scoped, input.fileId);
    if (!file || file.deletedAt) throw new FilesAccessError(`File ${input.fileId} is not visible.`);
    return bound.attachments.attach(scoped, {
      workspaceId: file.workspaceId,
      conversationId: input.conversationId,
      messageId: input.messageId ?? null,
      fileId: file.id,
      contentHash: file.contentHash,
    });
  }

  async detachFromConversation(actor: PersistenceActor, attachmentId: string) {
    const scoped = this.scoped(actor, 'detach file');
    return this.persistence.forActor(scoped).attachments.detach(scoped, attachmentId);
  }

  async createBinaryArtefact(
    actor: PersistenceActor,
    input: { projectId: string; bytes: Uint8Array; mimeType: string; type?: string; id?: string },
  ): Promise<ArtefactMetadata> {
    const scoped = this.scoped(actor, 'create binary artefact');
    const workspace = await this.requireProject(scoped, input.projectId);
    const mime = generatedMime(input.mimeType, input.bytes);
    const put = await this.cas.put(input.bytes);
    return this.persistence.run(async () => {
      const bound = this.persistence.forActor(scoped);
      await bound.casRefs.ensureObject(put.sha256, put.sizeBytes);
      const artefact = await this.persistence.artefacts.record(scoped, {
        id: input.id ?? `art_${randomUUID()}`,
        workspaceId: workspace.id,
        type: input.type ?? 'binary',
        version: 1,
        parentId: null,
        contentHash: put.sha256,
        mimeType: mime,
        sizeBytes: put.sizeBytes,
      });
      await bound.casRefs.addRef(scoped, {
        sha256: put.sha256,
        workspaceId: workspace.id,
        kind: 'artefact',
        ownerId: artefact.id,
      });
      await bound.provenance.record({
        artefactId: artefact.id,
        projectId: workspace.id,
        sourceInputs: [put.sha256],
        inputManifestHash: workspace.rootManifestHash,
        provider: 'atlas.files',
        model: 'artefact.v1',
        toolCalls: [],
        jobId: null,
        timestamp: this.clock(),
        traceId: artefact.id,
        capability: 'files.artefact',
      });
      return artefact;
    });
  }

  async readArtefactBytes(actor: PersistenceActor, artefactId: string): Promise<Uint8Array> {
    const scoped = this.scoped(actor, 'read artefact bytes');
    const artefact = await this.persistence.artefacts.get(scoped, artefactId);
    if (!artefact?.contentHash) throw new FilesAccessError(`Artefact ${artefactId} is not visible.`);
    const allowed = await this.persistence.forActor(scoped).casRefs.hasTenantAccess(scoped, artefact.contentHash);
    if (!allowed) throw new FilesAccessError('Fail-closed: hash does not grant artefact access.');
    return this.readCas(artefact.contentHash);
  }

  async createTextArtefact(
    actor: PersistenceActor,
    input: { projectId: string; text: string; type?: string; id?: string },
  ): Promise<ArtefactMetadata> {
    const scoped = this.scoped(actor, 'create artefact');
    const workspace = await this.requireProject(scoped, input.projectId);
    const bytes = new TextEncoder().encode(input.text);
    const put = await this.cas.put(bytes);
    return this.persistence.run(async () => {
      const bound = this.persistence.forActor(scoped);
      await bound.casRefs.ensureObject(put.sha256, put.sizeBytes);
      const artefact = await this.persistence.artefacts.record(scoped, {
        id: input.id ?? `art_${randomUUID()}`,
        workspaceId: workspace.id,
        type: input.type ?? 'document',
        version: 1,
        parentId: null,
        contentHash: put.sha256,
        mimeType: 'text/plain',
        sizeBytes: put.sizeBytes,
      });
      await bound.casRefs.addRef(scoped, {
        sha256: put.sha256,
        workspaceId: workspace.id,
        kind: 'artefact',
        ownerId: artefact.id,
      });
      await bound.provenance.record({
        artefactId: artefact.id,
        projectId: workspace.id,
        sourceInputs: [put.sha256],
        inputManifestHash: workspace.rootManifestHash,
        provider: 'atlas.files',
        model: 'artefact.v1',
        toolCalls: [],
        jobId: null,
        timestamp: this.clock(),
        traceId: artefact.id,
        capability: 'files.artefact',
      });
      return artefact;
    });
  }

  async versionTextArtefact(
    actor: PersistenceActor,
    parentId: string,
    input: { text: string; expectedVersion: number; id?: string },
  ): Promise<ArtefactMetadata> {
    const scoped = this.scoped(actor, 'version artefact');
    const bytes = new TextEncoder().encode(input.text);
    const put = await this.cas.put(bytes);
    return this.persistence.run(async () => {
      const bound = this.persistence.forActor(scoped);
      await bound.casRefs.ensureObject(put.sha256, put.sizeBytes);
      const artefact = await this.persistence.artefacts.createVersion(scoped, parentId, {
        id: input.id ?? `art_${randomUUID()}`,
        expectedVersion: input.expectedVersion,
        contentHash: put.sha256,
        mimeType: 'text/plain',
        sizeBytes: put.sizeBytes,
      });
      await bound.casRefs.addRef(scoped, {
        sha256: put.sha256,
        workspaceId: artefact.workspaceId,
        kind: 'artefact',
        ownerId: artefact.id,
      });
      return artefact;
    });
  }

  async readArtefactText(actor: PersistenceActor, artefactId: string): Promise<string> {
    const scoped = this.scoped(actor, 'read artefact');
    const artefact = await this.persistence.artefacts.get(scoped, artefactId);
    if (!artefact?.contentHash) throw new FilesAccessError(`Artefact ${artefactId} is not visible.`);
    const allowed = await this.persistence.forActor(scoped).casRefs.hasTenantAccess(scoped, artefact.contentHash);
    if (!allowed) throw new FilesAccessError('Fail-closed: hash does not grant artefact access.');
    return new TextDecoder().decode(await this.cas.get(artefact.contentHash));
  }

  async publishArtefactFile(
    actor: PersistenceActor,
    input: {
      projectId: string;
      path: string;
      displayName: string;
      artefactId: string;
      contentHash: string;
      mimeType?: string;
      sizeBytes?: number;
    },
  ): Promise<FileRecord> {
    const scoped = this.scoped(actor, 'publish artefact file');
    const workspace = await this.requireProject(scoped, input.projectId);
    const path = sanitiseRelPath(input.path);
    const mime = input.mimeType ?? 'text/plain';
    const sizeBytes = input.sizeBytes ?? 0;
    return this.persistence.run(async () => {
      const bound = this.persistence.forActor(scoped);
      const existing = await bound.files.getByPath(scoped, workspace.id, path);
      let file: FileRecord;
      if (existing) {
        if (existing.contentHash && existing.contentHash !== input.contentHash) {
          await bound.casRefs.removeRef(scoped, 'file', existing.id, existing.contentHash);
        }
        file = await bound.files.update(scoped, existing.id, {
          expectedRevision: existing.revision,
          displayName: input.displayName,
          mimeType: mime,
          sizeBytes,
          contentHash: input.contentHash,
          artefactId: input.artefactId,
          version: existing.version + 1,
        });
      } else {
        file = await bound.files.create(scoped, {
          id: `fil_${randomUUID()}`,
          workspaceId: workspace.id,
          path,
          displayName: input.displayName,
          mimeType: mime,
          sizeBytes,
          contentHash: input.contentHash,
          artefactId: input.artefactId,
          createdBy: scoped.principalId ?? null,
        });
      }
      await bound.fileVersions.append(scoped, {
        id: `fver_${randomUUID()}`,
        fileId: file.id,
        workspaceId: workspace.id,
        version: file.version,
        contentHash: input.contentHash,
        mimeType: mime,
        sizeBytes,
      });
      await bound.casRefs.addRef(scoped, {
        sha256: input.contentHash,
        workspaceId: workspace.id,
        kind: 'file',
        ownerId: file.id,
      });
      return file;
    });
  }

  private async requireProject(actor: PersistenceActor, projectId: string) {
    const workspace = await this.persistence.forActor(actor).workspaces.get(actor, projectId);
    if (!workspace) {
      throw new OwnershipError(`Fail-closed: project ${projectId} is not visible to tenant ${actor.tenantId}.`);
    }
    return workspace;
  }

  private scoped(actor: PersistenceActor, action: string): PersistenceActor {
    if (!actor.tenantId?.trim()) {
      throw new OwnershipError(`Fail-closed: cannot ${action} without a tenant id.`);
    }
    return actor;
  }

  private fileProvenance(file: FileRecord, artefact: ArtefactMetadata, stage: string): ProvenanceRecord {
    return {
      artefactId: artefact.id,
      projectId: file.workspaceId,
      sourceInputs: [file.contentHash],
      inputManifestHash: null,
      provider: 'atlas.files',
      model: `${EXTRACTOR_ID}.${EXTRACTOR_VERSION}`,
      toolCalls: [],
      jobId: null,
      timestamp: this.clock(),
      traceId: file.id,
      capability: `files.${stage}`,
    };
  }
}

const GENERATED_MIME_TYPES = new Set(['audio/wav', 'audio/midi', 'application/json', 'text/plain']);

function generatedMime(declared: string, bytes: Uint8Array): string {
  const mime = declared.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!GENERATED_MIME_TYPES.has(mime)) {
    throw new IngestionError(`Generated artefact MIME ${declared} is not permitted.`);
  }
  if (mime === 'audio/wav') {
    const riff = bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    const wave = bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;
    if (!riff || !wave) throw new IngestionError('Generated WAV failed RIFF/WAVE magic validation.');
  }
  if (mime === 'audio/midi') {
    const mthd = bytes.length >= 4 && bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64;
    if (!mthd) throw new IngestionError('Generated MIDI failed MThd magic validation.');
  }
  return mime;
}
