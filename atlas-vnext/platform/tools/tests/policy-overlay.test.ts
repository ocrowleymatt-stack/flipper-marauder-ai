import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultEffectivePolicy } from '@atlas-vnext/contracts';
import { AuthorityEngine, EffectivePolicyEngine } from '@atlas-vnext/permissions';
import {
  MemoryToolApprovalStore,
  MemoryToolInvocationStore,
  PLATFORM_TOOL_CATALOGUE,
  ToolEngine,
  ToolRegistry,
} from '../src/index.ts';

function engineWithPolicy(networkAccess: 'none' | 'public' | 'private' = 'public', toolsEnabled = true) {
  const registry = new ToolRegistry();
  for (const def of PLATFORM_TOOL_CATALOGUE) registry.register(def);
  const authority = new AuthorityEngine();
  const principalId = 'user_a';
  const tenantId = 'tenant_a';
  authority.grantMembership(principalId, tenantId);
  for (const capability of ['tool.invoke.readonly', 'tool.invoke', 'network.public', 'project.read', 'file.read'] as const) {
    authority.grantTo({ principalId, tenantId, capability });
  }
  const policy = new EffectivePolicyEngine(authority);
  const overlay = policy.parse(tenantId, null, {
    ...defaultEffectivePolicy(tenantId),
    networkAccess,
    toolsEnabled,
  });
  return {
    actor: { tenantId, principalId, workspaceId: 'wks_a' },
    engine: new ToolEngine({
      registry,
      invocations: new MemoryToolInvocationStore(),
      approvals: new MemoryToolApprovalStore(),
      authority,
      policy,
      resolvePolicy: () => overlay,
      jailRoot: mkdtempSync(join(tmpdir(), 'atlas-jail-')),
    }),
  };
}

describe('effective policy overlay for tools', () => {
  it('hides and denies network tools when networkAccess is none', async () => {
    const { engine, actor } = engineWithPolicy('none');
    const callable = (await engine.listCallable(actor)).map((tool) => tool.id);
    expect(callable).toContain('job.run');
    expect(callable).toContain('project.file_op');
    expect(callable).not.toContain('retrieval.search');
    expect(callable).not.toContain('api.read');
    expect(callable).not.toContain('browser.navigate');
    const search = await engine.invoke(actor, { toolId: 'retrieval.search', arguments: { query: 'Alpha' } });
    expect(search.invocation.status).toBe('denied');
    const read = await engine.invoke(actor, { toolId: 'api.read', arguments: { url: 'https://example.com/' } });
    expect(read.invocation.status).toBe('denied');
  });

  it('still advertises federated search when networkAccess is public', async () => {
    const { engine, actor } = engineWithPolicy('public');
    const callable = (await engine.listCallable(actor)).map((tool) => tool.id);
    expect(callable).toContain('retrieval.search');
    expect(callable).toContain('api.read');
    const search = await engine.invoke(actor, { toolId: 'retrieval.search', arguments: { query: 'Alpha' } });
    expect(search.invocation.status).toBe('succeeded');
  });

  it('advertises no tools when toolsEnabled is false', async () => {
    const { engine, actor } = engineWithPolicy('public', false);
    expect(await engine.listCallable(actor)).toEqual([]);
    const search = await engine.invoke(actor, { toolId: 'retrieval.search', arguments: { query: 'Alpha' } });
    expect(search.invocation.status).toBe('denied');
  });
});
