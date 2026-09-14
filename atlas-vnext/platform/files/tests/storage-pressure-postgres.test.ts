import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesystemCas, sha256Hex } from '@atlas-vnext/storage';
import { FilesAccessError, FilesService } from '@atlas-vnext/files';
import { ProjectService } from '@atlas-vnext/projects';
import { openTestKernel, tenantA, tenantB } from '../../persistence/tests/postgres/harness.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

function tempWebsite(generation: number): Array<{ path: string; bytes: Uint8Array }> {
  const css = generation % 4 === 0 ? `body { color: #${String(generation).padStart(3, '0')}; }` : 'body { margin: 0; }';
  return [
    { path: 'index.html', bytes: encode(`<!doctype html><html><h1>preview ${generation}</h1></html>`) },
    { path: 'styles.css', bytes: encode(css) },
    { path: 'assets/logo.txt', bytes: encode('SHARED-LOGO-BYTES') },
  ];
}

async function drainJobs(files: FilesService, actor: { tenantId: string }, limit = 200): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    if (!(await files.processNextJob(actor, `pg-storage-${i}`))) break;
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe('postgres storage-pressure restart', () => {
  it('bounds repeated temporary website generation across a process restart', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    const casRoot = mkdtempSync(join(tmpdir(), 'atlas-cas-site-'));
    const cas = new FilesystemCas({ root: casRoot });
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    await handle.kernel.ensureTenant({ id: tenantB.tenantId, name: 'B' });
    const projects = new ProjectService(handle.kernel);
    const files = new FilesService(handle.kernel, cas);
    const project = await projects.create(tenantA, { name: 'Web workspace' });
    const otherProject = await projects.create(tenantB, { name: 'Other' });

    const first = await files.sites.publish(tenantA, {
      projectId: project.id,
      name: 'preview',
      files: tempWebsite(1),
    });
    for (let n = 2; n <= 16; n += 1) {
      await files.sites.publish(tenantA, { projectId: project.id, name: 'preview', files: tempWebsite(n) });
    }
    const beforeJobs = await cas.physicalBytes();
    await drainJobs(files, tenantA);
    const afterGc = await files.sites.storageStats(tenantA);
    expect(afterGc.logicalSiteCount).toBe(1);
    expect(afterGc.retainedRevisionCount).toBe(3);
    expect(afterGc.casPhysicalBytes).toBeLessThan(beforeJobs);
    const tree = await files.sites.currentTree(tenantA, first.site.id);
    expect(decoder.decode(tree.entries.find((entry) => entry.path === 'index.html')!.bytes)).toContain('preview 16');

    const logoHash = sha256Hex(encode('SHARED-LOGO-BYTES'));
    await files.sites.publish(tenantB, {
      projectId: otherProject.id,
      name: 'preview',
      files: tempWebsite(1),
    });
    await expect(files.readByHash(tenantB, tree.entries.find((entry) => entry.path === 'index.html')!.contentHash)).rejects.toBeInstanceOf(
      FilesAccessError,
    );

    await handle.kernel.close();
    const restarted = await openTestKernel(handle.schema);
    cleanups.push(async () => {
      await restarted.kernel.close();
    });
    const cas2 = new FilesystemCas({ root: casRoot });
    const files2 = new FilesService(restarted.kernel, cas2);
    const again = await files2.sites.currentTree(tenantA, first.site.id);
    expect(again.site.id).toBe(first.site.id);
    expect(decoder.decode(again.entries.find((entry) => entry.path === 'index.html')!.bytes)).toContain('preview 16');
    expect(await cas2.has(logoHash)).toBe(true);
    const stats = await files2.sites.storageStats(tenantA);
    expect(stats.logicalSiteCount).toBe(1);
    expect(stats.retainedRevisionCount).toBe(3);

    const bound2 = restarted.kernel.forActor(tenantA);
    const retained = await bound2.sites.listRevisions(tenantA, first.site.id);
    const liveHashes = new Set<string>();
    for (const revision of retained) {
      for (const entry of await bound2.sites.listEntries(tenantA, revision.id)) {
        liveHashes.add(entry.contentHash);
      }
    }
    const orphaned = await files2.sites.materializeTree(tempWebsite(77));
    const uniqueOrphans = orphaned.filter((entry) => !liveHashes.has(entry.sha256));
    expect(uniqueOrphans.length).toBeGreaterThan(0);
    await files2.gcUnreferenced();
    for (const entry of uniqueOrphans) {
      expect(await cas2.has(entry.sha256)).toBe(false);
    }
    for (const hash of liveHashes) {
      expect(await cas2.has(hash)).toBe(true);
    }
    const still = await files2.sites.currentTree(tenantA, first.site.id);
    expect(decoder.decode(still.entries.find((entry) => entry.path === 'index.html')!.bytes)).toContain('preview 16');
    await expect(files2.readByHash(tenantB, still.entries.find((entry) => entry.path === 'index.html')!.contentHash)).rejects.toBeInstanceOf(
      FilesAccessError,
    );
  });

  it('survives expire-then-restart-then-GC without deleting live or cross-tenant objects', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    const cas = new FilesystemCas({ root: mkdtempSync(join(tmpdir(), 'atlas-cas-expire-')) });
    await handle.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    await handle.kernel.ensureTenant({ id: tenantB.tenantId, name: 'B' });
    const projects = new ProjectService(handle.kernel);
    const files = new FilesService(handle.kernel, cas);
    const project = await projects.create(tenantA, { name: 'A' });
    const otherProject = await projects.create(tenantB, { name: 'B' });
    const sharedCss = encode('body { margin: 0; }');
    await files.sites.publish(tenantB, {
      projectId: otherProject.id,
      name: 'preview',
      files: [
        { path: 'index.html', bytes: encode('<h1>b</h1>') },
        { path: 'styles.css', bytes: sharedCss },
      ],
    });
    const site = await files.sites.publish(tenantA, {
      projectId: project.id,
      name: 'preview',
      files: tempWebsite(1),
    });
    await files.sites.publish(tenantA, { projectId: project.id, name: 'preview', files: tempWebsite(2) });
    await files.sites.publish(tenantA, { projectId: project.id, name: 'preview', files: tempWebsite(3) });
    await files.sites.publish(tenantA, { projectId: project.id, name: 'preview', files: tempWebsite(4) });
    const expired = await files.sites.retainForTenant(tenantA);
    expect(expired.length).toBeGreaterThan(0);
    const schema = handle.schema;
    const casRoot = cas.root;
    await handle.kernel.close();

    const restarted = await openTestKernel(schema);
    cleanups.push(async () => {
      await restarted.kernel.close();
    });
    const cas2 = new FilesystemCas({ root: casRoot });
    const files2 = new FilesService(restarted.kernel, cas2);
    const reclaimed = await files2.gcUnreferenced();
    expect(reclaimed.length).toBeGreaterThan(0);
    const tree = await files2.sites.currentTree(tenantA, site.site.id);
    expect(decoder.decode(tree.entries.find((entry) => entry.path === 'index.html')!.bytes)).toContain('preview 4');
    const cssHash = sha256Hex(sharedCss);
    expect(await cas2.has(cssHash)).toBe(true);
    await expect(files2.readByHash(tenantB, cssHash)).resolves.toBeTruthy();
  });
});
