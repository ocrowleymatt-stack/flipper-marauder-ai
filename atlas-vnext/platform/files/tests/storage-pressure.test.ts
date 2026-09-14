import { describe, expect, it } from 'vitest';
import { openMemoryPersistence } from '@atlas-vnext/persistence';
import {
  CasPublicationError,
  MemoryCas,
  sha256Hex,
  type CasPutResult,
  type CasStat,
  type CasStore,
} from '@atlas-vnext/storage';
import { FilesAccessError, FilesService } from '@atlas-vnext/files';
import { ProjectService } from '@atlas-vnext/projects';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Small generated-site tree: not an HTTP server. */
function tempWebsite(generation: number): Array<{ path: string; bytes: Uint8Array }> {
  const css = generation % 4 === 0 ? `body { color: #${String(generation).padStart(3, '0')}; }` : 'body { margin: 0; }';
  return [
    { path: 'index.html', bytes: encode(`<!doctype html><html><h1>preview ${generation}</h1></html>`) },
    { path: 'styles.css', bytes: encode(css) },
    { path: 'assets/logo.txt', bytes: encode('SHARED-LOGO-BYTES') },
  ];
}

class SelectiveEnospcCas implements CasStore {
  readonly layout = 'sha256/<aa>/<bb>/<hash>' as const;
  failNext = false;

  constructor(private readonly inner: CasStore) {}

  objectPath(sha256: string): string {
    return this.inner.objectPath(sha256);
  }

  async put(bytes: Uint8Array): Promise<CasPutResult> {
    if (this.failNext) {
      const err = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      throw err;
    }
    return this.inner.put(bytes);
  }

  get(sha256: string): Promise<Uint8Array> {
    return this.inner.get(sha256);
  }

  has(sha256: string): Promise<boolean> {
    return this.inner.has(sha256);
  }

  stat(sha256: string): Promise<CasStat | null> {
    return this.inner.stat(sha256);
  }

  unlink(sha256: string): Promise<boolean> {
    return this.inner.unlink(sha256);
  }

  listObjects(): Promise<CasStat[]> {
    return this.inner.listObjects();
  }

  physicalBytes(): Promise<number> {
    return this.inner.physicalBytes();
  }
}

async function drainJobs(files: FilesService, actor: { tenantId: string }, limit = 200): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    if (!(await files.processNextJob(actor, `storage-w-${i}`))) break;
  }
}

describe('storage-pressure website revisions', () => {
  it('keeps one logical site, dedups identical files, bounds ephemeral history, and GCs reclaimably', async () => {
    const persistence = openMemoryPersistence();
    const cas = new MemoryCas();
    const files = new FilesService(persistence, cas);
    const projects = new ProjectService(persistence);
    const actor = { tenantId: 'tenant_a' };
    const other = { tenantId: 'tenant_b' };
    await persistence.ensureTenant({ id: 'tenant_a', name: 'A' });
    await persistence.ensureTenant({ id: 'tenant_b', name: 'B' });
    const project = await projects.create(actor, { name: 'Web workspace' });
    const otherProject = await projects.create(other, { name: 'Other tenant' });

    const first = await files.sites.publish(actor, {
      projectId: project.id,
      name: 'preview',
      files: tempWebsite(1),
    });
    const afterFirst = await cas.physicalBytes();
    const generations = 24;
    let last = first;
    for (let n = 2; n <= generations; n += 1) {
      last = await files.sites.publish(actor, {
        projectId: project.id,
        name: 'preview',
        files: tempWebsite(n),
      });
    }
    const afterMany = await cas.physicalBytes();
    expect(last.site.id).toBe(first.site.id);
    const listed = await persistence.forActor(actor).sites.list(actor, project.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('preview');
    expect(listed.some((row) => /site-v2|site-final/.test(row.name))).toBe(false);

    const logoHash = sha256Hex(encode('SHARED-LOGO-BYTES'));
    expect(await cas.has(logoHash)).toBe(true);
    const uniqueHtml = generations;
    expect(afterMany).toBeGreaterThan(afterFirst);
    expect(afterMany).toBeLessThan(afterFirst * uniqueHtml);

    await drainJobs(files, actor);
    const afterGc = await files.sites.storageStats(actor);
    expect(afterGc.logicalSiteCount).toBe(1);
    expect(afterGc.retainedRevisionCount).toBe(files.sites.policy.maxEphemeralRevisions);
    expect(afterGc.expiredRevisionCount).toBe(generations - files.sites.policy.maxEphemeralRevisions);
    expect(afterGc.casPhysicalBytes).toBeLessThan(afterMany);
    expect(afterGc.casPhysicalBytes).toBeLessThanOrEqual(afterFirst * 4);
    expect(afterGc.reclaimableBytes).toBe(0);
    expect(afterGc.deduplicatedBytes).toBeGreaterThan(0);

    const tree = await files.sites.currentTree(actor, first.site.id);
    expect(decoder.decode(tree.entries.find((entry) => entry.path === 'index.html')!.bytes)).toContain(
      `preview ${generations}`,
    );
    expect(decoder.decode(tree.entries.find((entry) => entry.path === 'assets/logo.txt')!.bytes)).toBe(
      'SHARED-LOGO-BYTES',
    );
    expect(await cas.has(logoHash)).toBe(true);

    const otherSite = await files.sites.publish(other, {
      projectId: otherProject.id,
      name: 'preview',
      files: tempWebsite(1),
    });
    await expect(files.readByHash(other, logoHash)).resolves.toBeTruthy();
    const foreignHtml = tree.entries.find((entry) => entry.path === 'index.html')!.contentHash;
    await expect(files.readByHash(other, foreignHtml)).rejects.toBeInstanceOf(FilesAccessError);
    await expect(files.sites.currentTree(other, first.site.id)).rejects.toThrow(/not visible|no current/i);
    expect(otherSite.site.id).not.toBe(first.site.id);

    const liveHashes = new Set(tree.entries.map((entry) => entry.contentHash));
    const reclaimed = await files.gcUnreferenced();
    for (const hash of liveHashes) {
      expect(reclaimed).not.toContain(hash);
      expect(await cas.has(hash)).toBe(true);
    }
  });

  it('retains pinned and published revisions beyond the ephemeral envelope', async () => {
    const persistence = openMemoryPersistence();
    const cas = new MemoryCas();
    const files = new FilesService(persistence, cas);
    const projects = new ProjectService(persistence);
    const actor = { tenantId: 'tenant_a' };
    await persistence.ensureTenant({ id: 'tenant_a', name: 'A' });
    const project = await projects.create(actor, { name: 'Published workspace' });
    const first = await files.sites.publish(actor, {
      projectId: project.id,
      name: 'marketing',
      files: tempWebsite(1),
    });
    await files.sites.preserve(actor, first.revision.id, 'published', 'production');
    for (let n = 2; n <= 6; n += 1) {
      await files.sites.publish(actor, { projectId: project.id, name: 'marketing', files: tempWebsite(n) });
    }
    await drainJobs(files, actor);
    const retained = await persistence.forActor(actor).sites.listRevisions(actor, first.site.id);
    expect(retained.some((row) => row.id === first.revision.id && row.retentionClass === 'published')).toBe(true);
    expect(retained.filter((row) => row.retentionClass === 'ephemeral')).toHaveLength(
      files.sites.policy.maxEphemeralRevisions,
    );
    const stats = await files.sites.storageStats(actor);
    expect(stats.retainedRevisionCount).toBe(files.sites.policy.maxEphemeralRevisions + 1);
  });

  it('fails closed on disk-full CAS publication without moving the current pointer', async () => {
    const persistence = openMemoryPersistence();
    const inner = new MemoryCas();
    const cas = new SelectiveEnospcCas(inner);
    const files = new FilesService(persistence, cas);
    const projects = new ProjectService(persistence);
    const actor = { tenantId: 'tenant_a' };
    const other = { tenantId: 'tenant_b' };
    await persistence.ensureTenant({ id: 'tenant_a', name: 'A' });
    await persistence.ensureTenant({ id: 'tenant_b', name: 'B' });
    const project = await projects.create(actor, { name: 'A' });
    const otherProject = await projects.create(other, { name: 'B' });
    await files.sites.publish(other, {
      projectId: otherProject.id,
      name: 'other',
      files: [{ path: 'index.html', bytes: encode('<p>tenant b</p>') }],
    });
    const first = await files.sites.publish(actor, {
      projectId: project.id,
      name: 'preview',
      files: tempWebsite(1),
    });
    cas.failNext = true;
    await expect(
      files.sites.publish(actor, { projectId: project.id, name: 'preview', files: tempWebsite(2) }),
    ).rejects.toBeInstanceOf(CasPublicationError);
    const tree = await files.sites.currentTree(actor, first.site.id);
    expect(decoder.decode(tree.entries.find((entry) => entry.path === 'index.html')!.bytes)).toContain('preview 1');
    const otherTree = await files.sites.currentTree(other, (await persistence.forActor(other).sites.listAll(other))[0]!.id);
    expect(decoder.decode(otherTree.entries[0]!.bytes)).toContain('tenant b');
  });

  it('reclaims CAS after crash between publication and metadata, and after expire-before-GC', async () => {
    const persistence = openMemoryPersistence();
    const cas = new MemoryCas();
    const files = new FilesService(persistence, cas);
    const projects = new ProjectService(persistence);
    const actor = { tenantId: 'tenant_a' };
    await persistence.ensureTenant({ id: 'tenant_a', name: 'A' });
    const project = await projects.create(actor, { name: 'Crash workspace' });
    const published = await files.sites.publish(actor, {
      projectId: project.id,
      name: 'preview',
      files: tempWebsite(1),
    });
    await drainJobs(files, actor);
    const beforeCrash = await cas.physicalBytes();

    const orphaned = await files.sites.materializeTree(tempWebsite(99));
    expect(await cas.physicalBytes()).toBeGreaterThan(beforeCrash);
    const restarted = new FilesService(persistence, cas);
    await restarted.gcUnreferenced();
    expect(await cas.physicalBytes()).toBe(beforeCrash);
    const tree = await restarted.sites.currentTree(actor, published.site.id);
    expect(decoder.decode(tree.entries.find((entry) => entry.path === 'index.html')!.bytes)).toContain('preview 1');
    for (const entry of orphaned) {
      const stillLive = tree.entries.some((item) => item.contentHash === entry.sha256);
      if (!stillLive) expect(await cas.has(entry.sha256)).toBe(false);
    }

    await restarted.sites.publish(actor, {
      projectId: project.id,
      name: 'preview',
      files: tempWebsite(2),
    });
    await restarted.sites.publish(actor, {
      projectId: project.id,
      name: 'preview',
      files: tempWebsite(3),
    });
    await restarted.sites.publish(actor, {
      projectId: project.id,
      name: 'preview',
      files: tempWebsite(4),
    });
    const expired = await restarted.sites.retainForTenant(actor);
    expect(expired.length).toBeGreaterThan(0);
    expect(expired).toContain(published.revision.id);
    const refsGone = await persistence.forActor(actor).casRefs.listRefsByOwner(actor, published.revision.id);
    expect(refsGone).toHaveLength(0);
    const reclaimable = await persistence.forActor(actor).casRefs.stats();
    expect(reclaimable.unreferencedCount).toBeGreaterThan(0);
    await restarted.gcUnreferenced();
    expect((await restarted.sites.storageStats(actor)).reclaimableBytes).toBe(0);
    const current = await restarted.sites.currentTree(actor, published.site.id);
    expect(decoder.decode(current.entries.find((entry) => entry.path === 'index.html')!.bytes)).toContain('preview 4');
  });

  it('does not unlink a CAS object while another revision or tenant still references it', async () => {
    const persistence = openMemoryPersistence();
    const cas = new MemoryCas();
    const files = new FilesService(persistence, cas);
    const projects = new ProjectService(persistence);
    const actor = { tenantId: 'tenant_a' };
    const other = { tenantId: 'tenant_b' };
    await persistence.ensureTenant({ id: 'tenant_a', name: 'A' });
    await persistence.ensureTenant({ id: 'tenant_b', name: 'B' });
    const projectA = await projects.create(actor, { name: 'A' });
    const projectB = await projects.create(other, { name: 'B' });
    const shared = [{ path: 'index.html', bytes: encode('<h1>shared</h1>') }, { path: 'styles.css', bytes: encode('body{}') }];
    await files.sites.publish(actor, { projectId: projectA.id, name: 'preview', files: shared });
    await files.sites.publish(other, { projectId: projectB.id, name: 'preview', files: shared });
    await files.sites.publish(actor, {
      projectId: projectA.id,
      name: 'preview',
      files: [{ path: 'index.html', bytes: encode('<h1>new</h1>') }, { path: 'styles.css', bytes: encode('body{}') }],
    });
    await drainJobs(files, actor);
    const cssHash = sha256Hex(encode('body{}'));
    expect(await cas.has(cssHash)).toBe(true);
    await expect(files.readByHash(other, cssHash)).resolves.toBeTruthy();
    await expect(files.readByHash(actor, cssHash)).resolves.toBeTruthy();
  });
});
