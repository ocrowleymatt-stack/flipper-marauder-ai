import { afterEach, describe, expect, it } from 'vitest';
import { ConflictError } from '../../src/errors.ts';
import { openPairedKernels, openTestKernel, postgresUrl, tenantA } from './harness.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const hasPostgres = Boolean(process.env.ATLAS_DATABASE_URL || process.env.DATABASE_URL || postgresUrl());

describe.skipIf(!hasPostgres)('document persistence', () => {
  it('keeps documents and versions across kernel reopen and isolates tenants', async () => {
    const first = await openTestKernel();
    cleanups.push(first.close);
    await first.kernel.ensureTenant({ id: 'tenant_a', name: 'A' });
    await first.kernel.ensureTenant({ id: 'tenant_b', name: 'B' });
    await first.kernel.ensurePrincipal({ id: 'principal_a' });
    const actorA = { tenantId: 'tenant_a', principalId: 'principal_a' };
    const workspace = await first.kernel.ensureWorkspace(actorA, { name: 'Book', dungeon: 'writing' });
    const docs = first.kernel.forActor(actorA).documents;
    const created = await docs.create(actorA, { workspaceId: workspace.id, title: 'Chapter' });
    const versioned = await docs.addVersion(actorA, created.id, {
      contentHash: 'a'.repeat(64),
      artefactId: 'art_1',
      title: 'Chapter',
      operation: 'create',
      expectedRevision: created.revision,
    });
    expect(versioned.document.currentVersion).toBe(1);

    const second = await openTestKernel(first.schema);
    cleanups.push(async () => {
      await second.kernel.close();
    });
    const reloaded = await second.kernel.forActor(actorA).documents.get(actorA, created.id);
    expect(reloaded?.title).toBe('Chapter');
    expect(reloaded?.currentVersion).toBe(1);
    const actorB = { tenantId: 'tenant_b', principalId: 'principal_b' };
    await second.kernel.ensurePrincipal({ id: 'principal_b' });
    expect(await second.kernel.forActor(actorB).documents.get(actorB, created.id)).toBeNull();
  });

  it('interrupts in-flight documents on recoverOnStart without promoting a draft', async () => {
    const first = await openTestKernel();
    cleanups.push(first.close);
    await first.kernel.ensureTenant({ id: 'tenant_a', name: 'A' });
    await first.kernel.ensurePrincipal({ id: 'principal_a' });
    const actorA = { tenantId: 'tenant_a', principalId: 'principal_a' };
    const workspace = await first.kernel.ensureWorkspace(actorA, { name: 'Book', dungeon: 'writing' });
    const docs = first.kernel.forActor(actorA).documents;
    const created = await docs.create(actorA, { workspaceId: workspace.id, title: 'Drafting' });
    await docs.update(actorA, created.id, { status: 'streaming', expectedRevision: created.revision });
    const recovered = await first.kernel.recoverOnStart();
    void recovered;
    const after = await docs.get(actorA, created.id);
    expect(after?.status).toBe('failed');
    expect(after?.failure?.code).toBe('interrupted');
    expect(after?.currentVersion).toBe(0);
  });

  it('lets only one concurrent same-revision update succeed', async () => {
    const pair = await openPairedKernels();
    cleanups.push(pair.close);
    await pair.a.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    await pair.a.ensurePrincipal({ id: 'principal_a' });
    const actorA = { tenantId: tenantA.tenantId, principalId: 'principal_a' };
    const workspace = await pair.a.ensureWorkspace(actorA, { name: 'Book', dungeon: 'writing' });
    const created = await pair.a.forActor(actorA).documents.create(actorA, { workspaceId: workspace.id, title: 'Chapter' });
    const results = await Promise.allSettled([
      pair.a.forActor(actorA).documents.update(actorA, created.id, {
        title: 'Left',
        expectedRevision: created.revision,
      }),
      pair.b.forActor(actorA).documents.update(actorA, created.id, {
        title: 'Right',
        expectedRevision: created.revision,
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status === 'rejected' && rejected[0].reason).toBeInstanceOf(ConflictError);
    const winner = fulfilled[0]?.status === 'fulfilled' ? fulfilled[0].value : null;
    const latest = await pair.a.forActor(actorA).documents.get(actorA, created.id);
    expect(latest?.revision).toBe(created.revision + 1);
    expect(latest?.title).toBe(winner?.title);
    expect(['Left', 'Right']).toContain(latest?.title);
  });

  it('lets only one concurrent same-revision addVersion succeed', async () => {
    const pair = await openPairedKernels();
    cleanups.push(pair.close);
    await pair.a.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    await pair.a.ensurePrincipal({ id: 'principal_a' });
    const actorA = { tenantId: tenantA.tenantId, principalId: 'principal_a' };
    const workspace = await pair.a.ensureWorkspace(actorA, { name: 'Book', dungeon: 'writing' });
    const created = await pair.a.forActor(actorA).documents.create(actorA, { workspaceId: workspace.id, title: 'Chapter' });
    const results = await Promise.allSettled([
      pair.a.forActor(actorA).documents.addVersion(actorA, created.id, {
        contentHash: 'a'.repeat(64),
        artefactId: 'art_left',
        title: 'Left',
        operation: 'create',
        expectedRevision: created.revision,
      }),
      pair.b.forActor(actorA).documents.addVersion(actorA, created.id, {
        contentHash: 'b'.repeat(64),
        artefactId: 'art_right',
        title: 'Right',
        operation: 'create',
        expectedRevision: created.revision,
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status === 'rejected' && rejected[0].reason).toBeInstanceOf(ConflictError);
    const latest = await pair.a.forActor(actorA).documents.get(actorA, created.id);
    expect(latest?.currentVersion).toBe(1);
    expect(latest?.status).toBe('committed');
    const versions = await pair.a.forActor(actorA).documents.listVersions(actorA, created.id);
    expect(versions).toHaveLength(1);
  });

  it('rolls back document version when a later write in the same transaction fails', async () => {
    const first = await openTestKernel();
    cleanups.push(first.close);
    await first.kernel.ensureTenant({ id: tenantA.tenantId, name: 'A' });
    await first.kernel.ensurePrincipal({ id: 'principal_a' });
    const actorA = { tenantId: tenantA.tenantId, principalId: 'principal_a' };
    const workspace = await first.kernel.ensureWorkspace(actorA, { name: 'Book', dungeon: 'writing' });
    const docs = first.kernel.forActor(actorA).documents;
    const created = await docs.create(actorA, { workspaceId: workspace.id, title: 'Chapter' });
    await expect(
      first.kernel.run(async () => {
        await docs.addVersion(actorA, created.id, {
          contentHash: 'c'.repeat(64),
          artefactId: 'art_tx',
          title: 'Chapter',
          operation: 'create',
          expectedRevision: created.revision,
        });
        throw new Error('injected provenance write failure');
      }),
    ).rejects.toThrow(/injected provenance write failure/);
    const after = await docs.get(actorA, created.id);
    expect(after?.currentVersion).toBe(0);
    expect(after?.status).toBe('idle');
    expect(after?.currentArtefactId).toBeNull();
    expect(await docs.listVersions(actorA, created.id)).toEqual([]);
  });
});
