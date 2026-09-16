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
  createAbortError,
  defaultAdapters,
  type ToolAdapter,
} from '../src/index.ts';

function hangingReadAdapter(): ToolAdapter {
  return {
    id: 'retrieval.readonly',
    async execute(_input, ctx) {
      await new Promise<void>((_resolve, reject) => {
        if (ctx.signal.aborted) {
          reject(createAbortError());
          return;
        }
        ctx.signal.addEventListener('abort', () => reject(createAbortError()), { once: true });
      });
      return { output: { hits: [] } };
    },
  };
}

function hangingMutateAdapter(started: { value: boolean }): ToolAdapter {
  return {
    id: 'test.mutate',
    async execute(input, ctx) {
      started.value = true;
      const url = String(input.url ?? '');
      await ctx.recordEffect(`test.mutate:${ctx.actor.tenantId}:${url}`, { url });
      await new Promise<void>((_resolve, reject) => {
        if (ctx.signal.aborted) {
          reject(createAbortError());
          return;
        }
        ctx.signal.addEventListener('abort', () => reject(createAbortError()), { once: true });
      });
      return { output: { status: 201, url } };
    },
  };
}

function makeEngine(adapters: ToolAdapter[], extraDefs: typeof PLATFORM_TOOL_CATALOGUE = []) {
  const registry = new ToolRegistry();
  for (const def of PLATFORM_TOOL_CATALOGUE) registry.register(def);
  for (const def of extraDefs) registry.register(def);
  const authority = new AuthorityEngine();
  const principalId = 'user_a';
  const tenantId = 'tenant_a';
  authority.grantMembership(principalId, tenantId);
  const invocations = new MemoryToolInvocationStore();
  return {
    authority,
    actor: { tenantId, principalId, workspaceId: 'wks_a' },
    other: { tenantId: 'tenant_b', principalId: 'user_b', workspaceId: 'wks_b' },
    invocations,
    engine: new ToolEngine({
      registry,
      invocations,
      approvals: new MemoryToolApprovalStore(),
      authority,
      jailRoot: mkdtempSync(join(tmpdir(), 'atlas-jail-')),
      adapters: [...defaultAdapters(), ...adapters],
    }),
  };
}

describe('callable tool advertisement', () => {
  it('lists only tools the current principal/tenant is authorised to invoke', () => {
    const { engine, actor, other, authority } = makeEngine([]);
    authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: 'tool.invoke.readonly' });
    authority.grantMembership(other.principalId, other.tenantId);
    authority.grantTo({
      principalId: other.principalId,
      tenantId: other.tenantId,
      capability: 'admin.configure',
    });

    const callable = engine.listCallable(actor).map((tool) => tool.id);
    expect(callable).toContain('retrieval.search');
    expect(callable).not.toContain('fs.write');
    expect(callable).not.toContain('admin.configure');

    const foreign = engine.listCallable(other).map((tool) => tool.id);
    expect(foreign).toContain('admin.configure');
    expect(foreign).not.toContain('retrieval.search');
  });
});

describe('cancellation into running tools', () => {
  it('cancels an active read-only invocation when the execution signal aborts', async () => {
    const { engine, actor, authority, invocations } = makeEngine([hangingReadAdapter()]);
    authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: 'tool.invoke.readonly' });
    const controller = new AbortController();
    const pending = engine.invoke(
      actor,
      { toolId: 'retrieval.search', arguments: { query: 'Alpha' } },
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await pending;
    expect(result.invocation.status).toBe('cancelled');
    expect(result.invocation.cancelConfirmed).toBe(true);
    expect(await invocations.listByStatus(actor.tenantId, ['running', 'authorised'])).toEqual([]);
    expect((await engine.get(actor, result.invocation.id))?.status).toBe('cancelled');
  });

  it('marks a mutating invocation uncertain rather than pretending cancellation proved no side effect', async () => {
    const started = { value: false };
    const mutate = {
      ...PLATFORM_TOOL_CATALOGUE.find((row) => row.id === 'api.mutate')!,
      id: 'test.mutate',
      adapter: 'test.mutate',
      approvalPolicy: 'none' as const,
    };
    const { engine, actor, authority, invocations } = makeEngine([hangingMutateAdapter(started)], [mutate]);
    authority.grantTo({ principalId: actor.principalId, tenantId: actor.tenantId, capability: 'network.public' });
    authority.grantTo({
      principalId: actor.principalId,
      tenantId: actor.tenantId,
      capability: 'tool.invoke.external_write',
    });
    const controller = new AbortController();
    const pending = engine.invoke(
      actor,
      { toolId: 'test.mutate', arguments: { url: 'https://example.test/x' } },
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started.value).toBe(true);
    controller.abort();
    const result = await pending;
    expect(result.invocation.status).toBe('uncertain');
    expect(result.invocation.failureReason?.code).toBe('interrupted_uncertain');
    expect(result.invocation.cancelConfirmed).toBe(false);
    expect(await invocations.listByStatus(actor.tenantId, ['running', 'authorised', 'cancelled'])).toEqual([]);
    expect((await engine.get(actor, result.invocation.id))?.status).toBe('uncertain');
  });
});
