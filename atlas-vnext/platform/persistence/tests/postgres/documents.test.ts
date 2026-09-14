import { afterEach, describe, expect, it } from 'vitest';
import { openTestKernel, postgresUrl } from './harness.ts';

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
});
