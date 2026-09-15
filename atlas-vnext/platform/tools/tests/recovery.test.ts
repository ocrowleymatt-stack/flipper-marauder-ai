import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuthorityEngine } from '@atlas-vnext/permissions';
import {
  MemoryToolApprovalStore,
  MemoryToolInvocationStore,
  PLATFORM_TOOL_CATALOGUE,
  ToolEngine,
  ToolRegistry,
} from '../src/index.ts';

describe('tool recovery', () => {
  it('marks interrupted uncertain external work as uncertain and does not re-execute', async () => {
    const registry = new ToolRegistry();
    for (const def of PLATFORM_TOOL_CATALOGUE) registry.register(def);
    const authority = new AuthorityEngine();
    authority.grantMembership('user_a', 'tenant_a');
    authority.grantTo({ principalId: 'user_a', tenantId: 'tenant_a', capability: 'network.public' });
    authority.grantTo({ principalId: 'user_a', tenantId: 'tenant_a', capability: 'tool.invoke.external_write' });
    const invocations = new MemoryToolInvocationStore();
    const engine = new ToolEngine({
      registry,
      invocations,
      approvals: new MemoryToolApprovalStore(),
      authority,
      jailRoot: mkdtempSync(join(tmpdir(), 'atlas-jail-')),
    });
    const actor = { tenantId: 'tenant_a', principalId: 'user_a' };
    const pending = await engine.invoke(actor, { toolId: 'api.mutate', arguments: { url: 'https://example.test' } });
    expect(pending.invocation.status).toBe('awaiting_approval');
    const running = {
      ...pending.invocation,
      status: 'running' as const,
      attemptCount: 1,
      sideEffectClass: 'uncertain_external' as const,
      updatedAt: new Date().toISOString(),
    };
    await invocations.save(running, ['awaiting_approval']);
    const recovered = await engine.reconcile();
    expect(recovered.some((row) => row.id === pending.invocation.id && row.status === 'uncertain')).toBe(true);
    await expect(
      engine.invoke(actor, { toolId: 'api.mutate', arguments: { url: 'https://example.test' } }),
    ).rejects.toThrow(/uncertain external side effect/i);
    const stored = await engine.get(actor, pending.invocation.id);
    expect(stored?.status).toBe('uncertain');
  });
});
