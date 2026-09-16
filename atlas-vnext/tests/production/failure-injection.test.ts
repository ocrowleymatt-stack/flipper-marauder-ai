import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CasMissingError, FilesService } from '@atlas-vnext/files';
import { openFilesystemCas } from '@atlas-vnext/storage';
import { ExecutionBroker, type ProviderAdapter } from '@atlas-vnext/execution';
import type { RouteDecision, StreamChunk } from '@atlas-vnext/contracts';
import { ConflictError, openMemoryPersistence } from '@atlas-vnext/persistence';
import {
  MemoryToolApprovalStore,
  MemoryToolInvocationStore,
  PLATFORM_TOOL_CATALOGUE,
  ToolEngine,
  ToolRegistry,
} from '@atlas-vnext/tools';
import { AuthorityEngine } from '@atlas-vnext/permissions';
import { EnvFlagStore } from '@atlas-vnext/flags';

const actorA = { tenantId: 'tenant_a', principalId: 'principal_a' };
const actorB = { tenantId: 'tenant_b', principalId: 'principal_b' };

function decision(chain: string[]): RouteDecision {
  const [primary] = chain;
  const [provider, model] = (primary ?? 'openai/gpt').split('/');
  return {
    target: 'nexus/fast',
    resolvedRouteId: primary ?? 'openai/gpt',
    provider: provider ?? 'openai',
    model: model ?? 'gpt',
    candidateChain: chain,
    localOnly: false,
    locality: 'public_cloud',
    runtimeClass: 'always_available',
    decisionReason: 'test',
    traceId: 'trc_test',
    evaluatedAt: new Date().toISOString(),
  };
}

describe('failure-injection harness', () => {
  it('detects CAS metadata/object divergence and never invents bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-cas-div-'));
    const persistence = openMemoryPersistence();
    await persistence.ensureTenant({ id: actorA.tenantId, name: 'A' });
    const workspace = await persistence.ensureWorkspace(actorA, { name: 'Proj' });
    const cas = await openFilesystemCas(join(dir, 'cas'));
    const files = new FilesService(persistence, cas);
    const stored = await files.ingest(actorA, {
      projectId: workspace.id,
      path: 'notes.md',
      bytes: new TextEncoder().encode('copper kettle'),
    });
    expect((await files.inspectCas(actorA, stored.id)).object).toBe('ok');
    rmSync(cas.objectPath(stored.contentHash), { force: true });
    expect((await files.inspectCas(actorA, stored.id)).object).toBe('missing');
    await expect(files.readBytes(actorA, stored.id)).rejects.toBeInstanceOf(CasMissingError);
    await persistence.close();
  });

  it('fails over only before visible output and stays terminal after visible text', async () => {
    const before = new ExecutionBroker(1);
    const unavailable: ProviderAdapter = {
      providerId: 'openai',
      async *stream() {
        throw new Error('provider unavailable before tokens');
      },
    };
    const healthy: ProviderAdapter = {
      providerId: 'anthropic',
      async *stream() {
        yield { type: 'text', text: 'rescued' };
      },
    };
    before.register(unavailable);
    before.register(healthy);
    const recovered: StreamChunk[] = [];
    for await (const chunk of before.execute(decision(['openai/gpt-4o', 'anthropic/claude-sonnet']), { prompt: 'hi' })) {
      recovered.push(chunk);
    }
    expect(recovered).toEqual([{ type: 'text', text: 'rescued' }]);

    const after = new ExecutionBroker(1);
    after.register({
      providerId: 'openai',
      async *stream() {
        yield { type: 'text', text: 'partial' };
        throw new Error('fail after visible');
      },
    });
    after.register(healthy);
    const texts: StreamChunk[] = [];
    await expect(async () => {
      for await (const chunk of after.execute(decision(['openai/gpt-4o', 'anthropic/claude-sonnet']), { prompt: 'hi' })) {
        texts.push(chunk);
      }
    }).rejects.toThrow(/fail after visible/);
    expect(texts).toEqual([{ type: 'text', text: 'partial' }]);
  });

  it('marks uncertain tool work and refuses blind replay', async () => {
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
    await invocations.save(
      {
        ...pending.invocation,
        status: 'running',
        attemptCount: 1,
        sideEffectClass: 'uncertain_external',
        updatedAt: new Date().toISOString(),
      },
      ['awaiting_approval'],
    );
    const recovered = await engine.reconcile();
    expect(recovered.some((row) => row.id === pending.invocation.id && row.status === 'uncertain')).toBe(true);
    await expect(engine.invoke(actor, { toolId: 'api.mutate', arguments: { url: 'https://example.test' } })).rejects.toThrow(
      /uncertain external side effect/i,
    );
  });

  it('rejects stale document revisions as conflicts', async () => {
    const persistence = openMemoryPersistence();
    await persistence.ensureTenant({ id: actorA.tenantId, name: 'A' });
    const workspace = await persistence.ensureWorkspace(actorA, { name: 'Book', dungeon: 'writing' });
    const docs = persistence.forActor(actorA).documents;
    const created = await docs.create(actorA, { workspaceId: workspace.id, title: 'Ch' });
    await docs.update(actorA, created.id, { title: 'Ch 2', expectedRevision: created.revision });
    await expect(docs.update(actorA, created.id, { title: 'stale', expectedRevision: created.revision })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await persistence.close();
  });

  it('isolates tenant B from tenant A ids', async () => {
    const persistence = openMemoryPersistence();
    await persistence.ensureTenant({ id: actorA.tenantId, name: 'A' });
    await persistence.ensureTenant({ id: actorB.tenantId, name: 'B' });
    const workspace = await persistence.ensureWorkspace(actorA, { name: 'A' });
    expect(await persistence.forActor(actorB).workspaces.get(actorB, workspace.id)).toBeNull();
    await persistence.close();
  });

  it('does not treat kill switches as Authority', () => {
    const flags = new EnvFlagStore({ ATLAS_FLAG_TOOLS: 'off' });
    expect(flags.enabled('tools')).toBe(false);
    const authority = new AuthorityEngine();
    authority.grantMembership(actorA.principalId, actorA.tenantId);
    authority.grantTo({ principalId: actorA.principalId, tenantId: actorA.tenantId, capability: 'tool.invoke' });
    const verdict = authority.decide({
      principal: { principalId: actorA.principalId, kind: 'user', tenantId: actorA.tenantId },
      capability: 'tool.invoke',
    });
    expect(verdict.decision).toBe('ALLOW');
  });
});
