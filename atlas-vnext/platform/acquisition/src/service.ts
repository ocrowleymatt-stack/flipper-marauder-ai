import { randomUUID } from 'node:crypto';
import type {
  AcquisitionEntry,
  AcquisitionManifest,
  AcquisitionSourceKind,
  AcquisitionStatus,
  ProvenanceRecord,
} from '@atlas-vnext/contracts';
import { acquisitionManifestSchema } from '@atlas-vnext/contracts';
import { ALLOWED_MIME_TYPES, FILE_JOB_INGEST, FilesService, sanitiseRelPath } from '@atlas-vnext/files';
import type { DurableJobEngine } from '@atlas-vnext/jobs';
import type { FileRecord, PersistenceActor, PlatformPersistence } from '@atlas-vnext/persistence';
import { AuthorityEngine } from '@atlas-vnext/permissions';
import type { ProjectService } from '@atlas-vnext/projects';
import { sha256Hex } from '@atlas-vnext/storage';
import { AcquisitionError, GENERIC_DENY } from './errors.ts';

export const ACQUISITION_JOB_DUNGEON = 'platform';
export const ACQUISITION_JOB_PROCESS = 'acquisition.process';

function originalStoredPath(id: string, rel: string): string {
  return sanitiseRelPath(`acquisition/${id}/originals/${rel}`);
}

function manifestStoredPath(id: string): string {
  return sanitiseRelPath(`acquisition/${id}/manifest.json`);
}

export interface AcquisitionActor extends PersistenceActor {
  principalId: string;
  tenantId: string;
}

export interface BeginAcquisitionInput {
  projectId: string;
  sourceKind: AcquisitionSourceKind;
  title: string;
  acquiredFrom: string;
  items: Array<{ path: string; bytes: Uint8Array; mime?: string; kind?: string }>;
  generation?: number;
}

type MutableManifest = AcquisitionManifest & { manifestHash?: string; fileIds: string[] };

/**
 * Authorised local-data acquisition. Originals go to FilesService.ingestAcquisitionOriginal / CAS.
 * Extraction reuses the files.ingest worker (`extractAndChunk`); this service
 * never calls an LLM and never walks the host filesystem.
 */
export class AcquisitionService {
  private readonly records = new Map<string, MutableManifest>();

  constructor(
    private readonly deps: {
      persistence: PlatformPersistence;
      files: FilesService;
      projects: ProjectService;
      authority: AuthorityEngine;
    },
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  /** DurableJobEngine is used via persistence; the jobs package is not modified. */
  private jobs(actor: AcquisitionActor): DurableJobEngine {
    return this.deps.persistence.forActor(this.scoped(actor)).jobs;
  }

  async begin(actor: AcquisitionActor, input: BeginAcquisitionInput): Promise<AcquisitionManifest> {
    const project = await this.requireProject(actor, input.projectId, 'file.write');
    if (!input.items?.length) {
      throw new AcquisitionError('malformed', 'Acquisition requires at least one caller-supplied item.');
    }

    const id = `acq_${randomUUID()}`;
    const acquiredAt = this.clock();
    const generation = input.generation ?? 1;
    const hashed: Array<{
      path: string;
      storedPath: string;
      bytes: Uint8Array;
      sha256: string;
      sizeBytes: number;
      mime?: string;
      kind: string;
    }> = [];

    const paths = new Set<string>();
    for (const item of input.items) {
      const rel = sanitiseRelPath(item.path);
      if (sanitiseRelPath(rel) !== rel) throw new AcquisitionError('malformed', 'Original path must have a stable normalized form.');
      const storedPath = originalStoredPath(id, rel);
      if (paths.has(storedPath)) throw new AcquisitionError('malformed', 'Duplicate original path.');
      paths.add(storedPath);
      const sha256 = sha256Hex(item.bytes);
      hashed.push({
        path: rel,
        storedPath,
        bytes: item.bytes,
        sha256,
        sizeBytes: item.bytes.byteLength,
        mime: item.mime,
        kind: item.kind?.trim() || 'original',
      });
    }

    const ingested: Array<{ entry: AcquisitionEntry; file: FileRecord }> = [];
    let failure: AcquisitionManifest['failure'] = null;

    for (const item of hashed) {
      try {
        const file = await this.deps.files.ingestAcquisitionOriginal(
          actor,
          {
            projectId: project.id,
            path: item.storedPath,
            bytes: item.bytes,
            declaredMime: item.mime,
          },
          item.kind !== 'archive',
        );
        if (file.contentHash !== item.sha256) {
          throw new AcquisitionError('hash_mismatch', 'CAS hash diverged from pre-ingest sha256.');
        }
        ingested.push({
          file,
          entry: {
            path: item.path,
            sha256: item.sha256,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            kind: item.kind,
          },
        });
      } catch (err) {
        failure = {
          code: err instanceof AcquisitionError ? err.code : 'ingest_failed',
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
          at: this.clock(),
        };
        break;
      }
    }

    const entries: AcquisitionEntry[] =
      ingested.length === hashed.length
        ? ingested.map((row) => row.entry)
        : hashed.map((item) => {
            const done = ingested.find((row) => row.entry.sha256 === item.sha256 && row.entry.path === item.path);
            return (
              done?.entry ?? {
                path: item.path,
                sha256: item.sha256,
                mimeType: item.mime || 'application/octet-stream',
                sizeBytes: item.sizeBytes,
                kind: item.kind,
              }
            );
          });

    const accepted = failure === null && ingested.length === hashed.length;
    const status: AcquisitionStatus = accepted ? 'accepted' : 'failed';
    const originalCasHash = hashAcquisitionOriginals(entries);
    const sizeBytes = hashed.reduce((sum, item) => sum + item.sizeBytes, 0);
    const title = input.title.trim() || 'Untitled acquisition';
    const acquiredFrom = input.acquiredFrom.trim() || 'caller';

    const manifest: AcquisitionManifest = {
      id,
      tenantId: actor.tenantId,
      workspaceId: project.id,
      sourceKind: input.sourceKind,
      title,
      originalCasHash,
      sizeBytes,
      acquiredAt,
      acquiredFrom,
      itemCount: hashed.length,
      entries,
      status,
      failure,
      generation,
    };

    let manifestHash: string | undefined;
    let manifestFile: FileRecord | undefined;
    try {
      const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
      manifestFile = await this.deps.files.ingestAcquisitionOriginal(
        actor,
        {
          projectId: project.id,
          path: sanitiseRelPath(manifestStoredPath(id)),
          bytes: manifestBytes,
          declaredMime: 'application/json',
        },
        true,
      );
      manifestHash = manifestFile.contentHash;
    } catch (err) {
      if (accepted) {
        manifest.status = 'failed';
        manifest.failure = {
          code: 'manifest_ingest_failed',
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
          at: this.clock(),
        };
      }
    }

    if (manifest.status === 'accepted' && manifestFile) {
      const sourceInputs = [
        ...ingested.map((row) => row.file.id),
        ...ingested.map((row) => row.file.contentHash),
        manifestFile.contentHash,
      ];
      const provenance: ProvenanceRecord = {
        artefactId: manifestFile.artefactId ?? manifestFile.id,
        projectId: project.id,
        sourceInputs,
        inputManifestHash: originalCasHash,
        provider: 'atlas.acquisition',
        model: 'deterministic',
        toolCalls: [],
        jobId: null,
        timestamp: this.clock(),
        traceId: id,
        capability: 'acquisition',
      };
      await this.deps.persistence.forActor(actor).provenance.record(provenance);
      await this.jobs(actor).enqueue(actor, {
        dungeon: ACQUISITION_JOB_DUNGEON,
        type: ACQUISITION_JOB_PROCESS,
        workspaceId: project.id,
        projectId: project.id,
        idempotencyKey: `${ACQUISITION_JOB_PROCESS}:${id}:${originalCasHash}`,
        checkpoint: {
          acquisitionId: id,
          fileIds: ingested.map((row) => row.file.id),
          manifestHash,
        },
      });
    }

    const stored: MutableManifest = {
      ...manifest,
      manifestHash,
      fileIds: ingested.map((row) => row.file.id),
    };
    this.records.set(id, stored);
    return this.snapshot(stored);
  }

  async get(actor: AcquisitionActor, id: string): Promise<AcquisitionManifest> {
    this.assertActor(actor);
    const record = this.records.get(id) ?? (await this.loadPersisted(actor, id));
    if (!record || record.tenantId !== actor.tenantId) {
      throw new AcquisitionError('not_found', GENERIC_DENY, 404);
    }
    await this.requireProject(actor, record.workspaceId, 'file.read');
    this.records.set(id, record);
    return this.snapshot(record);
  }

  /**
   * Thin worker: claims `acquisition.process` (and `files.ingest` if that job
   * is next) and runs FilesService.extractAndChunk. Extraction is deterministic
   * and reuses the files ingest pipeline — no LLM.
   */
  async processNext(
    actor: AcquisitionActor,
    workerId: string,
    leaseMs = 30_000,
  ): Promise<FileRecord[] | FileRecord | null> {
    const scoped = this.scoped(actor);
    const bound = this.deps.persistence.forActor(scoped);
    const job = await bound.jobs.claimNext(scoped, workerId, leaseMs, {
      types: [ACQUISITION_JOB_PROCESS, FILE_JOB_INGEST],
    });
    if (!job) return null;
    const fileIds =
      job.type === ACQUISITION_JOB_PROCESS
        ? ((job.checkpoint.fileIds as string[] | undefined) ?? [])
        : job.type === FILE_JOB_INGEST
          ? [String(job.checkpoint.fileId ?? '')].filter(Boolean)
          : [];
    if (fileIds.length === 0) {
      await bound.jobs.fail(scoped, job.id, {
        code: 'unsupported_job',
        message: `Acquisition worker does not handle ${job.type}`,
        retryable: false,
      });
      return null;
    }
    try {
      const files: FileRecord[] = [];
      for (const fileId of fileIds) {
        const file = await this.deps.files.getMetadata(scoped, fileId);
        if (!file) throw new AcquisitionError('not_found', GENERIC_DENY, 404);
        files.push((ALLOWED_MIME_TYPES as readonly string[]).includes(file.mimeType)
          ? await this.deps.files.extractAndChunk(scoped, fileId, job.id)
          : file);
      }
      await bound.jobs.checkpoint(scoped, job.id, 'extracted', 1, { fileIds });
      await bound.jobs.complete(scoped, job.id);
      return files.length === 1 ? (files[0] ?? null) : files;
    } catch (err) {
      await bound.jobs.fail(scoped, job.id, {
        code: 'acquisition.process_failed',
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      });
      throw err;
    }
  }

  /** Optional alias: same as FilesService.extractAndChunk after file.read. */
  async extract(actor: AcquisitionActor, fileId: string, jobId?: string): Promise<FileRecord> {
    this.assertActor(actor);
    const file = await this.deps.files.getMetadata(actor, fileId);
    if (!file) throw new AcquisitionError('not_found', GENERIC_DENY, 404);
    await this.requireProject(actor, file.workspaceId, 'file.read');
    return this.deps.files.extractAndChunk(actor, fileId, jobId);
  }

  private async loadPersisted(actor: AcquisitionActor, id: string): Promise<MutableManifest | null> {
    const projects = await this.deps.projects.list(actor, { includeArchived: true });
    for (const project of projects) {
      const files = await this.deps.files.list(actor, project.id);
      const manifestFile = files.find((file) => file.path === manifestStoredPath(id));
      if (!manifestFile) continue;
      await this.requireProject(actor, project.id, 'file.read');
      const bytes = await this.deps.files.readBytes(actor, manifestFile.id);
      const parsed = acquisitionManifestSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
      if (!parsed.success) continue;
      const prefix = `acquisition/${id}/originals/`;
      const fileIds = files.filter((file) => file.path.startsWith(prefix)).map((file) => file.id);
      return {
        ...parsed.data,
        manifestHash: manifestFile.contentHash,
        fileIds,
      };
    }
    return null;
  }

  private snapshot(record: MutableManifest): AcquisitionManifest {
    return structuredClone({
      id: record.id,
      tenantId: record.tenantId,
      workspaceId: record.workspaceId,
      sourceKind: record.sourceKind,
      title: record.title,
      originalCasHash: record.originalCasHash,
      sizeBytes: record.sizeBytes,
      acquiredAt: record.acquiredAt,
      acquiredFrom: record.acquiredFrom,
      itemCount: record.itemCount,
      entries: record.entries.map((entry) => ({ ...entry })),
      status: record.status,
      failure: record.failure ? { ...record.failure } : null,
      generation: record.generation,
    });
  }

  private async requireProject(actor: AcquisitionActor, projectId: string, capability: 'file.write' | 'file.read') {
    this.assertActor(actor);
    const project = await this.deps.projects.get(actor, projectId);
    if (!project) throw new AcquisitionError('not_found', GENERIC_DENY, 404);
    const verdict = this.deps.authority.decide({
      principal: {
        principalId: actor.principalId,
        kind: 'user',
        tenantId: actor.tenantId,
        workspaceId: project.id,
      },
      capability,
      resource: {
        type: 'file',
        id: project.id,
        tenantId: project.tenantId,
        workspaceId: project.id,
      },
    });
    if (verdict.decision !== 'ALLOW') {
      throw new AcquisitionError('permission_denied', GENERIC_DENY, 404);
    }
    return project;
  }

  private assertActor(actor: AcquisitionActor): void {
    if (!actor.tenantId?.trim() || !actor.principalId?.trim()) {
      throw new AcquisitionError('permission_denied', GENERIC_DENY, 401);
    }
  }

  private scoped(actor: AcquisitionActor): PersistenceActor {
    this.assertActor(actor);
    return actor;
  }
}

export function hashAcquisitionOriginals(entries: AcquisitionEntry[]): string {
  const canonical = [...entries]
    .map((entry) => ({
      path: entry.path,
      sha256: entry.sha256.toLowerCase(),
      mimeType: entry.mimeType,
      sizeBytes: entry.sizeBytes,
      kind: entry.kind,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
    return sha256Hex(new TextEncoder().encode(JSON.stringify(canonical)));
}
