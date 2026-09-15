import { afterEach, describe, expect, it } from 'vitest';
import { AuthorityEngine } from '@atlas-vnext/permissions';
import {
  PLATFORM_TOOL_CATALOGUE,
  ToolEngine,
  ToolRegistry,
} from '@atlas-vnext/tools';
import { openTestKernel, tenantA, tenantB } from './harness.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe('postgres tool isolation and recovery', () => {
  it('tenant A cannot access tenant B invocations; awaiting approval survives restart', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    await handle.kernel.ensureTenant({ id: 'tenant_a', name: 'A' });
    await handle.kernel.ensureTenant({ id: 'tenant_b', name: 'B' });
    await handle.kernel.ensurePrincipal({ id: 'user_a' });
    await handle.kernel.ensurePrincipal({ id: 'user_b' });
    const a = handle.kernel.forActor(tenantA);
    const b = handle.kernel.forActor(tenantB);
    const registry = new ToolRegistry();
    for (const def of PLATFORM_TOOL_CATALOGUE) registry.register(def);
    const authority = new AuthorityEngine();
    authority.grantMembership('user_a', 'tenant_a');
    authority.grantTo({ principalId: 'user_a', tenantId: 'tenant_a', capability: 'filesystem.write' });
    authority.grantTo({ principalId: 'user_a', tenantId: 'tenant_a', capability: 'file.write' });
    authority.grantTo({ principalId: 'user_a', tenantId: 'tenant_a', capability: 'tool.invoke.external_write' });
    const engine = new ToolEngine({
      registry,
      invocations: a.toolInvocations,
      approvals: a.toolApprovals,
      authority,
    });
    const pending = await engine.invoke(
      { tenantId: 'tenant_a', principalId: 'user_a' },
      { toolId: 'fs.write', arguments: { path: 'x.txt', content: 'hi' } },
    );
    expect(pending.invocation.status).toBe('awaiting_approval');
    const leaked = await b.toolInvocations.get('tenant_b', pending.invocation.id);
    expect(leaked).toBeNull();
    const recovered = await handle.kernel.recoverOnStart();
    expect(recovered.tools).toEqual({ uncertain: 0, failed: 0 });
    const still = await a.toolInvocations.get('tenant_a', pending.invocation.id);
    expect(still?.status).toBe('awaiting_approval');
    const approved = await engine.approve(
      { tenantId: 'tenant_a', principalId: 'user_a' },
      pending.invocation.id,
      'approved',
    );
    expect(approved.invocation.status).toBe('succeeded');
  });
});
