import { randomUUID } from 'node:crypto';
import type { ManifestEntry } from '@atlas-vnext/contracts';
import { logPlatform } from '@atlas-vnext/observability';
import {
  OwnershipError,
  type PersistenceActor,
  type PlatformPersistence,
  type SiteRecord,
  type SiteRetentionClass,
  type SiteRevisionEntry,
  type SiteRevisionRecord,
} from '@atlas-vnext/persistence';
import {
  CasPublicationError,
  RetentionLimitError,
  hashManifestEntries,
  isDiskFullError,
  sha256Hex,
  type CasStore,
} from '@atlas-vnext/storage';
import { FilesAccessError } from './errors.ts';
import { sanitiseRelPath } from './path.ts';

export const STORAGE_JOB_DUNGEON = 'platform';
export const STORAGE_JOB_RETAIN = 'storage.retain';
export const STORAGE_JOB_GC = 'storage.gc';

/** Temporary websites keep a deliberately small envelope unless pinned/published. */
export const DEFAULT_SITE_RETENTION = {
  maxEphemeralRevisions: 3,
  maxPinnedRevisions: 32,
  maxPublishedRevisions: 32,
} as const;

export interface SiteRetentionPolicy {
  maxEphemeralRevisions: number;
  maxPinnedRevisions: number;
  maxPublishedRevisions: number;
}

export interface SiteFileInput {
  path: string;
  bytes: Uint8Array;
  mimeType?: string;
}

export interface PublishSiteInput {
  projectId: string;
  name: string;
  files: SiteFileInput[];
  retentionClass?: SiteRetentionClass;
  pinReason?: string | null;
}

export interface PublishedSiteRevision {
  site: SiteRecord;
  revision: SiteRevisionRecord;
  entries: SiteRevisionEntry[];
}

export interface SiteStorageStats {
  logicalSiteCount: number;
  retainedRevisionCount: number;
  expiredRevisionCount: number;
  casPhysicalBytes: number;
  catalogBytes: number;
  logicalBytes: number;
  deduplicatedBytes: number;
  reclaimableBytes: number;
  catalogObjectCount: number;
  unreferencedCount: number;
}

export interface CurrentSiteTree {
  site: SiteRecord;
  revision: SiteRevisionRecord;
  entries: Array<SiteRevisionEntry & { bytes: Uint8Array }>;
}

interface MaterializedEntry {
  path: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  deduplicated: boolean;
}

export class SiteService {
  constructor(
    private readonly persistence: PlatformPersistence,
    private readonly cas: CasStore,
    private readonly clock: () => string = () => new Date().toISOString(),
    readonly policy: SiteRetentionPolicy = DEFAULT_SITE_RETENTION,
  ) {}

  async ensure(actor: PersistenceActor, input: { projectId: string; name: string }): Promise<SiteRecord> {
    const scoped = this.scoped(actor, 'ensure site');
    const workspace = await this.requireProject(scoped, input.projectId);
    const bound = this.persistence.forActor(scoped);
    const existing = await bound.sites.getByName(scoped, workspace.id, input.name);
    if (existing) return existing;
    return bound.sites.create(scoped, {
      id: `site_${randomUUID()}`,
      workspaceId: workspace.id,
      name: input.name,
    });
  }

  /**
   * Publish a generated website as one logical site with a current-revision pointer.
   * CAS blobs are written first; the current pointer is updated only after metadata commits.
   */
  async publish(actor: PersistenceActor, input: PublishSiteInput): Promise<PublishedSiteRevision> {
    const scoped = this.scoped(actor, 'publish site');
    const workspace = await this.requireProject(scoped, input.projectId);
    const retentionClass = input.retentionClass ?? 'ephemeral';
    const materialized = await this.materializeTree(input.files);
    const manifestEntries: ManifestEntry[] = materialized.map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
      mimeType: entry.mimeType,
      sizeBytes: entry.sizeBytes,
      executable: false,
    }));
    const manifestHash = hashManifestEntries(manifestEntries);
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({ version: 1, projectId: workspace.id, manifestHash, entries: manifestEntries, createdAt: this.clock() }),
    );
    let manifestPut;
    try {
      manifestPut = await this.cas.put(manifestBytes);
    } catch (err) {
      throw this.failClosedPublish(err);
    }
    return this.persistence.run(async () => {
      const bound = this.persistence.forActor(scoped);
      let site = await bound.sites.getByName(scoped, workspace.id, input.name);
      if (!site) {
        site = await bound.sites.create(scoped, {
          id: `site_${randomUUID()}`,
          workspaceId: workspace.id,
          name: input.name,
        });
      }
      const previous = site.currentRevisionId ? await bound.sites.getRevision(scoped, site.currentRevisionId) : null;
      const version = previous ? previous.version + 1 : 1;
      if (retentionClass === 'pinned' || retentionClass === 'published') {
        await this.assertStrongRetentionRoom(scoped, site.id, retentionClass);
      }
      const artefact = await this.persistence.artefacts.record(scoped, {
        id: `art_${randomUUID()}`,
        workspaceId: workspace.id,
        type: 'site',
        version,
        parentId: previous?.artefactId ?? null,
        contentHash: manifestHash,
        mimeType: 'application/json',
        sizeBytes: manifestPut.sizeBytes,
      });
      const revision = await bound.sites.createRevision(scoped, {
        id: `srev_${randomUUID()}`,
        siteId: site.id,
        workspaceId: workspace.id,
        artefactId: artefact.id,
        parentId: previous?.id ?? null,
        version,
        manifestHash,
        retentionClass,
        pinReason: input.pinReason ?? null,
        retainedUntil: null,
      });
      const entries = await bound.sites.replaceEntries(
        scoped,
        revision.id,
        materialized.map((entry) => ({
          path: entry.path,
          contentHash: entry.sha256,
          mimeType: entry.mimeType,
          sizeBytes: entry.sizeBytes,
        })),
      );
      await bound.casRefs.ensureObject(manifestPut.sha256, manifestPut.sizeBytes);
      await bound.casRefs.addRef(scoped, {
        sha256: manifestPut.sha256,
        workspaceId: workspace.id,
        kind: 'site_revision',
        ownerId: revision.id,
      });
      const uniqueHashes = new Map<string, number>();
      for (const entry of materialized) {
        uniqueHashes.set(entry.sha256, entry.sizeBytes);
      }
      for (const [sha256, sizeBytes] of uniqueHashes) {
        await bound.casRefs.ensureObject(sha256, sizeBytes);
        await bound.casRefs.addRef(scoped, {
          sha256,
          workspaceId: workspace.id,
          kind: 'site_entry',
          ownerId: revision.id,
        });
      }
      site = await bound.sites.setCurrentRevision(scoped, site.id, revision.id);
      await bound.jobs.enqueue(scoped, {
        dungeon: STORAGE_JOB_DUNGEON,
        type: STORAGE_JOB_RETAIN,
        workspaceId: workspace.id,
        projectId: workspace.id,
        idempotencyKey: `storage.retain:${scoped.tenantId}:${site.id}:${version}`,
        checkpoint: { siteId: site.id, revisionId: revision.id },
      });
      await bound.jobs.enqueue(scoped, {
        dungeon: STORAGE_JOB_DUNGEON,
        type: STORAGE_JOB_GC,
        workspaceId: workspace.id,
        projectId: workspace.id,
        checkpoint: { reason: 'site.publish', siteId: site.id, revisionId: revision.id },
      });
      await bound.provenance.record({
        artefactId: artefact.id,
        projectId: workspace.id,
        sourceInputs: [...uniqueHashes.keys()],
        inputManifestHash: manifestHash,
        provider: 'atlas.files',
        model: 'site.revision.v1',
        toolCalls: [],
        jobId: null,
        timestamp: this.clock(),
        traceId: revision.id,
        capability: 'sites.publish',
      });
      logPlatform('sites.publish', {
        tenantId: scoped.tenantId,
        workspaceId: workspace.id,
        siteId: site.id,
        revisionId: revision.id,
        version,
        retentionClass,
        entryCount: entries.length,
        uniqueHashes: uniqueHashes.size,
        manifestHash,
        logicalSites: 1,
      });
      return { site, revision, entries };
    });
  }

  async currentTree(actor: PersistenceActor, siteId: string): Promise<CurrentSiteTree> {
    const scoped = this.scoped(actor, 'read current site');
    const bound = this.persistence.forActor(scoped);
    const site = await bound.sites.get(scoped, siteId);
    if (!site?.currentRevisionId) {
      throw new FilesAccessError(`Fail-closed: site ${siteId} has no current revision.`);
    }
    const revision = await bound.sites.getRevision(scoped, site.currentRevisionId);
    if (!revision || revision.expiredAt) {
      throw new FilesAccessError(`Fail-closed: current site revision is not visible.`);
    }
    const entries = await bound.sites.listEntries(scoped, revision.id);
    const withBytes: CurrentSiteTree['entries'] = [];
    for (const entry of entries) {
      const allowed = await bound.casRefs.hasTenantAccess(scoped, entry.contentHash);
      if (!allowed) {
        throw new FilesAccessError('Fail-closed: hash does not grant access without a tenant-owned ref.');
      }
      withBytes.push({ ...entry, bytes: await this.cas.get(entry.contentHash) });
    }
    return { site, revision, entries: withBytes };
  }

  async preserve(
    actor: PersistenceActor,
    revisionId: string,
    retentionClass: 'pinned' | 'published',
    pinReason?: string,
  ): Promise<SiteRevisionRecord> {
    const scoped = this.scoped(actor, 'preserve site revision');
    return this.persistence.run(async () => {
      const bound = this.persistence.forActor(scoped);
      const revision = await bound.sites.getRevision(scoped, revisionId);
      if (!revision || revision.expiredAt) {
        throw new FilesAccessError(`Fail-closed: site revision ${revisionId} is not visible.`);
      }
      await this.assertStrongRetentionRoom(scoped, revision.siteId, retentionClass, revision.id);
      const next = await bound.sites.setRetentionClass(scoped, revisionId, retentionClass, pinReason ?? null);
      logPlatform('sites.preserve', {
        tenantId: scoped.tenantId,
        siteId: revision.siteId,
        revisionId,
        retentionClass,
      });
      return next;
    });
  }

  async retainForTenant(actor: PersistenceActor): Promise<string[]> {
    const scoped = this.scoped(actor, 'retain sites');
    const expiredIds: string[] = [];
    await this.persistence.run(async () => {
      const bound = this.persistence.forActor(scoped);
      const sites = await bound.sites.listAll(scoped);
      for (const site of sites) {
        const retained = await bound.sites.listRevisions(scoped, site.id);
        const ephemeral = retained
          .filter((item) => item.retentionClass === 'ephemeral')
          .sort((a, b) => a.version - b.version);
        const overflow = Math.max(0, ephemeral.length - this.policy.maxEphemeralRevisions);
        const victims = ephemeral
          .filter((item) => item.id !== site.currentRevisionId)
          .slice(0, overflow);
        for (const victim of victims) {
          if (victim.id === site.currentRevisionId) continue;
          await bound.casRefs.removeRefsByOwner(scoped, victim.id);
          await bound.sites.expireRevision(scoped, victim.id);
          expiredIds.push(victim.id);
          logPlatform('sites.retain.expired', {
            tenantId: scoped.tenantId,
            siteId: site.id,
            revisionId: victim.id,
            version: victim.version,
            retentionClass: victim.retentionClass,
          });
        }
      }
      if (expiredIds.length > 0) {
        await bound.jobs.enqueue(scoped, {
          dungeon: STORAGE_JOB_DUNGEON,
          type: STORAGE_JOB_GC,
          workspaceId: scoped.workspaceId ?? null,
          checkpoint: { reason: 'site.retain', expiredRevisionIds: expiredIds },
        });
      }
    });
    return expiredIds;
  }

  async storageStats(actor: PersistenceActor): Promise<SiteStorageStats> {
    const scoped = this.scoped(actor, 'observe site storage');
    const bound = this.persistence.forActor(scoped);
    const counts = await bound.sites.counts(scoped);
    const catalog = await bound.casRefs.stats();
    const casPhysicalBytes = await this.cas.physicalBytes();
    const stats: SiteStorageStats = {
      logicalSiteCount: counts.logicalSites,
      retainedRevisionCount: counts.retainedRevisions,
      expiredRevisionCount: counts.expiredRevisions,
      casPhysicalBytes,
      catalogBytes: catalog.catalogBytes,
      logicalBytes: counts.logicalBytes,
      deduplicatedBytes: Math.max(0, counts.logicalBytes - counts.uniqueBytes),
      reclaimableBytes: catalog.unreferencedBytes,
      catalogObjectCount: catalog.objectCount,
      unreferencedCount: catalog.unreferencedCount,
    };
    logPlatform('sites.stats', {
      tenantId: scoped.tenantId,
      ...stats,
    });
    return stats;
  }

  /**
   * Write tree bytes into CAS without metadata. Used by crash tests and by publish.
   * Fail-closed: disk-full does not update any site pointer.
   */
  async materializeTree(files: SiteFileInput[]): Promise<MaterializedEntry[]> {
    if (files.length === 0) {
      throw new FilesAccessError('A site revision requires at least one file.');
    }
    const materialized: MaterializedEntry[] = [];
    try {
      for (const file of files) {
        const path = sanitiseRelPath(file.path);
        const put = await this.cas.put(file.bytes);
        if (put.sha256 !== sha256Hex(file.bytes)) {
          throw new CasPublicationError('CAS hash verification failed after put.');
        }
        materialized.push({
          path,
          sha256: put.sha256,
          mimeType: mimeForSitePath(path, file.mimeType),
          sizeBytes: put.sizeBytes,
          deduplicated: put.deduplicated,
        });
      }
    } catch (err) {
      throw this.failClosedPublish(err);
    }
    return materialized;
  }

  private async assertStrongRetentionRoom(
    actor: PersistenceActor,
    siteId: string,
    retentionClass: 'pinned' | 'published',
    excludeId?: string,
  ): Promise<void> {
    const bound = this.persistence.forActor(actor);
    const retained = await bound.sites.listRevisions(actor, siteId);
    const count = retained.filter(
      (item) => item.retentionClass === retentionClass && item.id !== excludeId,
    ).length;
    const cap = retentionClass === 'pinned' ? this.policy.maxPinnedRevisions : this.policy.maxPublishedRevisions;
    if (count >= cap) {
      throw new RetentionLimitError(
        `${retentionClass} site revision retention exceeded (${count + 1} > ${cap}).`,
      );
    }
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

  private failClosedPublish(err: unknown): Error {
    if (err instanceof CasPublicationError) return err;
    if (isDiskFullError(err)) {
      return new CasPublicationError('CAS publication failed: disk full. Metadata was not updated.', {
        cause: err,
        code: 'ENOSPC',
      });
    }
    return err instanceof Error ? err : new CasPublicationError(String(err));
  }
}

function mimeForSitePath(path: string, declared?: string): string {
  if (declared) return declared;
  const lower = path.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.css')) return 'text/css';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.txt') || lower.endsWith('.svg')) return 'text/plain';
  return 'application/octet-stream';
}
