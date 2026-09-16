import { describe, expect, it } from 'vitest';
import { openMemoryPersistence } from '../src/index.ts';

describe('dungeon estate persistence', () => {
  it('isolates dungeon records and privacy policies by tenant', async () => {
    const persistence = await openMemoryPersistence();
    await persistence.ensureTenant({ id: 'tenant_a', name: 'A' });
    await persistence.ensureTenant({ id: 'tenant_b', name: 'B' });
    const a = persistence.forActor({ tenantId: 'tenant_a', principalId: 'principal_a' });
    const b = persistence.forActor({ tenantId: 'tenant_b', principalId: 'principal_b' });
    await persistence.ensureWorkspace({ tenantId: 'tenant_a', principalId: 'principal_a' }, { id: 'ws_a', name: 'A' });
    const created = await a.dungeonRecords.create(
      { tenantId: 'tenant_a', principalId: 'principal_a' },
      { workspaceId: 'ws_a', dungeon: 'osint', kind: 'target', title: 'example.com', payload: { value: 'example.com' } },
    );
    expect(await b.dungeonRecords.get({ tenantId: 'tenant_b', principalId: 'principal_b' }, created.id)).toBeNull();
    const policy = await a.privacy.upsertPolicy(
      { tenantId: 'tenant_a', principalId: 'owner_a' },
      { dungeonId: null, payload: { networkAccess: 'none' }, updatedBy: 'owner_a' },
    );
    expect(policy.revision).toBe(1);
    expect(await b.privacy.getPolicy({ tenantId: 'tenant_b', principalId: 'principal_b' }, null)).toBeNull();
    const audit = await a.privacy.appendAudit(
      { tenantId: 'tenant_a', principalId: 'owner_a' },
      {
        actorId: 'owner_a',
        action: 'policy.update',
        capability: 'privacy.configure',
        resource: null,
        decision: 'ALLOW',
        reasonCode: 'allow',
        before: null,
        after: { networkAccess: 'none' },
        stepUp: true,
      },
    );
    expect(audit.tenantId).toBe('tenant_a');
    const foreignAudit = await b.privacy.listAudit({ tenantId: 'tenant_b', principalId: 'principal_b' });
    expect(foreignAudit).toEqual([]);
    await persistence.close();
  });
});
