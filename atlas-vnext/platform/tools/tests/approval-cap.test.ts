import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_OPERATIONAL_LIMITS, type ToolInvocationStatus } from '@atlas-vnext/contracts';
import { AuthorityEngine } from '@atlas-vnext/permissions';
import {
  MemoryToolApprovalStore,
  MemoryToolInvocationStore,
  PLATFORM_TOOL_CATALOGUE,
  ToolEngine,
  ToolError,
  ToolRegistry,
} from '../src/index.ts';

class DelayedListStore extends MemoryToolInvocationStore {
  async listByStatus(tenantId: string | null, statuses: ToolInvocationStatus[]) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return super.listByStatus(tenantId, statuses);
  }
}

function approvalEngine(maxPendingApprovals: number, invocations = new MemoryToolInvocationStore()) {
  const registry = new ToolRegistry();
  for (const def of PLATFORM_TOOL_CATALOGUE) registry.register(def);
  const authority = new AuthorityEngine();
  const principalId = 'user_a';
  const tenantId = 'tenant_a';
  authority.grantMembership(principalId, tenantId);
  for (const cap of ['filesystem.write', 'file.write', 'tool.invoke.external_write'] as const) {
    authority.grantTo({ principalId, tenantId, capability: cap });
  }
  return {
    invocations,
    engine: new ToolEngine({
      registry,
      invocations,
      approvals: new MemoryToolApprovalStore(),
      authority,
      jailRoot: mkdtempSync(join(tmpdir(), 'atlas-jail-')),
      limits: { ...DEFAULT_OPERATIONAL_LIMITS, maxPendingApprovals },
    }),
    actor: { tenantId, principalId, workspaceId: 'wks_a' },
  };
}

describe('approval ceiling reservation', () => {
  it('rejects further approval work at the ceiling without leaving authorised orphans', async () => {
    const { engine, actor, invocations } = approvalEngine(1);
    const first = await engine.invoke(actor, {
      toolId: 'fs.write',
      arguments: { path: 'kept.txt', content: 'ok' },
    });
    expect(first.invocation.status).toBe('awaiting_approval');

    await expect(
      engine.invoke(actor, { toolId: 'fs.write', arguments: { path: 'extra.txt', content: 'nope' } }),
    ).rejects.toMatchObject({ code: 'rate_limit' } satisfies Partial<ToolError>);

    expect(await invocations.listByStatus(actor.tenantId, ['authorised'])).toEqual([]);
    expect(await invocations.listByStatus(actor.tenantId, ['proposed', 'validated'])).toEqual([]);
    const awaiting = await invocations.listByStatus(actor.tenantId, ['awaiting_approval']);
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]?.id).toBe(first.invocation.id);
    expect(await engine.reconcile()).toEqual([]);
    expect((await engine.get(actor, first.invocation.id))?.status).toBe('awaiting_approval');
  });

  it('serializes concurrent approval reservations so the ceiling cannot be raced', async () => {
    const { engine, actor, invocations } = approvalEngine(2, new DelayedListStore());
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        engine.invoke(actor, {
          toolId: 'fs.write',
          arguments: { path: `race-${i}.txt`, content: 'x' },
        }),
      ),
    );
    const accepted = results.filter(
      (row) => row.status === 'fulfilled' && row.value.invocation.status === 'awaiting_approval',
    );
    const rejected = results.filter((row) => row.status === 'rejected');
    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(10);
    for (const row of rejected) {
      expect(row.status).toBe('rejected');
      expect((row as PromiseRejectedResult).reason).toMatchObject({ code: 'rate_limit' });
    }
    expect(await invocations.listByStatus(actor.tenantId, ['authorised'])).toEqual([]);
    expect(await invocations.listByStatus(actor.tenantId, ['proposed', 'validated', 'queued', 'running'])).toEqual([]);
    expect(await invocations.listByStatus(actor.tenantId, ['awaiting_approval'])).toHaveLength(2);
    expect(await invocations.listByStatus(actor.tenantId, ['failed'])).toEqual([]);
  });
});
