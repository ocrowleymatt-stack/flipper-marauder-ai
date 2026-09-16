import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthorityEngine } from '@atlas-vnext/permissions';
import { PostgresPersistence } from '@atlas-vnext/persistence';
import {
  MemoryToolApprovalStore,
  MemoryToolInvocationStore,
  ToolEngine,
  ToolRegistry,
} from '@atlas-vnext/tools';
import { composeSpine, createHost, grantSideEffects, listen, type Spine } from '../../apps/host/src/index.ts';
import { openTestKernel, persistenceConfig, postgresUrl } from '../../platform/persistence/tests/postgres/harness.ts';
import { authHeaders, bootstrap, startProductionHost } from './harness.ts';

const servers: Server[] = [];
const spines: Spine[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
  await Promise.all(spines.splice(0).map((spine) => spine.close().catch(() => undefined)));
  while (cleanups.length) await cleanups.pop()?.();
});

const hasPostgres = Boolean(process.env.ATLAS_DATABASE_URL || process.env.DATABASE_URL || postgresUrl());

describe('release-candidate adversarial drills', () => {
  it('rejects malformed JSON, missing sessions, and guessed foreign ids', async () => {
    const started = await startProductionHost();
    servers.push(started.server);
    spines.push(started.spine);
    const missing = await fetch(`${started.url}/api/projects`);
    expect(missing.status).toBe(401);
    const session = await bootstrap(started.url);
    const malformed = await fetch(`${started.url}/api/projects`, {
      method: 'POST',
      headers: authHeaders(session),
      body: '{not-json',
    });
    expect(malformed.status).toBe(400);
    const guessed = await fetch(`${started.url}/api/documents/doc_other_tenant`, {
      headers: authHeaders(session),
    });
    expect(guessed.status).toBe(404);
    const guessedBody = (await guessed.json()) as { error: string; code?: string };
    expect(guessedBody.error).not.toMatch(/tenant_b/i);
  });

  it('isolates tenant B from tenant A HTTP objects', async () => {
    const a = await startProductionHost({ tenantId: 'tenant_a' });
    const b = await startProductionHost({ tenantId: 'tenant_b' });
    servers.push(a.server, b.server);
    spines.push(a.spine, b.spine);
    const sessionA = await bootstrap(a.url);
    const sessionB = await bootstrap(b.url);
    const created = await fetch(`${a.url}/api/projects`, {
      method: 'POST',
      headers: authHeaders(sessionA),
      body: JSON.stringify({ name: 'Secret' }),
    });
    expect(created.status).toBe(201);
    const project = (await created.json()) as { id: string };
    const cross = await fetch(`${b.url}/api/projects/${project.id}`, { headers: authHeaders(sessionB) });
    expect(cross.status).toBe(404);
    const listed = await fetch(`${b.url}/api/projects`, { headers: authHeaders(sessionB) });
    const body = (await listed.json()) as Array<{ id: string }>;
    expect(body.some((row) => row.id === project.id)).toBe(false);
  });

  it('treats expired and revoked sessions as signed out', async () => {
    const started = await startProductionHost({ env: { ATLAS_SESSION_TTL_MS: '40' } });
    servers.push(started.server);
    spines.push(started.spine);
    const session = await bootstrap(started.url);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const expired = await fetch(`${started.url}/api/projects`, { headers: authHeaders(session) });
    expect([401, 403]).toContain(expired.status);

    const freshHost = await startProductionHost();
    servers.push(freshHost.server);
    spines.push(freshHost.spine);
    const live = await bootstrap(freshHost.url);
    const revoke = await fetch(`${freshHost.url}/api/session/revoke`, {
      method: 'POST',
      headers: authHeaders(live),
      body: '{}',
    });
    expect(revoke.status).toBe(200);
    const after = await fetch(`${freshHost.url}/api/projects`, { headers: authHeaders(live) });
    expect([401, 403]).toContain(after.status);
  });

  it('cancels an in-flight mock stream and refuses mutating work after shutdown', async () => {
    const started = await startProductionHost({ streamDelayMs: 80 });
    servers.push(started.server);
    spines.push(started.spine);
    const session = await bootstrap(started.url);
    const conversationRes = await fetch(`${started.url}/api/conversations`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({}),
    });
    const conversation = (await conversationRes.json()) as { id: string };
    const stream = await fetch(`${started.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ content: 'stream please', capability: 'nexus/fast' }),
    });
    expect(stream.body).toBeTruthy();
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let executionId: string | null = null;
    const frames: Array<{ event: string; data: Record<string, unknown> }> = [];
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const block of parts) {
        let event = 'message';
        let data: Record<string, unknown> | null = null;
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          if (line.startsWith('data: ')) data = JSON.parse(line.slice(6)) as Record<string, unknown>;
        }
        if (!data) continue;
        frames.push({ event, data });
        const execution = data.execution as { id?: string } | undefined;
        if (execution?.id) executionId = execution.id;
      }
      if (executionId) {
        const cancel = await fetch(`${started.url}/api/executions/${executionId}/cancel`, {
          method: 'POST',
          headers: authHeaders(session),
          body: '{}',
        });
        expect(cancel.status).toBe(200);
        break;
      }
    }
    expect(executionId).toBeTruthy();
    await reader.cancel().catch(() => undefined);

    started.spine.shutdown.begin();
    const blocked = await fetch(`${started.url}/api/projects`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ name: 'after-shutdown' }),
    });
    expect(blocked.status).toBe(503);
    const payload = (await blocked.json()) as { code: string };
    expect(payload.code).toBe('shutting_down');
    const ready = await fetch(`${started.url}/api/health/ready`);
    expect(ready.status).toBe(503);
    const readyBody = (await ready.json()) as { ha: boolean; ready: boolean };
    expect(readyBody.ready).toBe(false);
    expect(readyBody.ha).toBe(false);
  });

  it('times out a hanging tool without inventing success', async () => {
    const registry = new ToolRegistry();
    registry.register({
      id: 'hang.probe',
      version: '1.0.0',
      title: 'Hang',
      description: 'Hangs until aborted.',
      category: 'retrieval_readonly',
      adapter: 'hang',
      requiredCapabilities: ['tool.invoke.readonly'],
      sideEffectClass: 'none',
      approvalPolicy: 'none',
      timeoutMs: 40,
      cancelSupported: true,
      idempotency: 'none',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      outputSchema: { type: 'object' },
    });
    const authority = new AuthorityEngine();
    authority.grantMembership('user_a', 'tenant_a');
    authority.grantTo({ principalId: 'user_a', tenantId: 'tenant_a', capability: 'tool.invoke.readonly' });
    const engine = new ToolEngine({
      registry,
      invocations: new MemoryToolInvocationStore(),
      approvals: new MemoryToolApprovalStore(),
      authority,
      jailRoot: mkdtempSync(join(tmpdir(), 'atlas-hang-')),
      adapters: [
        {
          id: 'hang',
          async execute(_input, ctx) {
            await new Promise<void>((_resolve, reject) => {
              if (ctx.signal.aborted) {
                reject(new Error('aborted'));
                return;
              }
              ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            });
            return { output: { ok: true } };
          },
        },
      ],
    });
    const result = await engine.invoke(
      { tenantId: 'tenant_a', principalId: 'user_a' },
      { toolId: 'hang.probe', arguments: {} },
    );
    expect(result.invocation.status).toBe('failed');
    expect(result.invocation.failureReason?.code).toBe('timeout');
    expect(result.invocation.failureReason?.message).toMatch(/timed out/i);
    expect(result.output).toBeUndefined();
  });
});

describe.skipIf(!hasPostgres)('postgres interruption and restart', () => {
  it('marks the host not-ready after the pool is interrupted and restores durable rows on reopen', async () => {
    const handle = await openTestKernel();
    cleanups.push(handle.close);
    const dir = mkdtempSync(join(tmpdir(), 'atlas-pg-adv-'));
    const persistence = {
      ...persistenceConfig(handle.schema),
      defaultTenantId: 'tenant_a',
    };
    const spine = await composeSpine({
      dataPath: join(dir, 'state.json'),
      mode: 'mock',
      persistence,
      casRoot: join(dir, 'cas'),
      env: {
        ATLAS_TENANT_ID: 'tenant_a',
        ATLAS_SESSION_SECRET: 'test-session-secret-not-for-production-use',
      },
    });
    grantSideEffects(spine.authority, spine.principalId, spine.tenantId);
    const server = createHost({
      runtime: spine.runtime,
      auth: spine.auth,
      tools: spine.tools,
      projects: spine.projects,
      files: spine.files,
      context: spine.context,
      persistence: spine.persistence,
      writing: spine.writing,
      tenantId: spine.tenantId,
      principalId: spine.principalId,
      production: false,
      probe: spine.healthProbe,
      shutdown: spine.shutdown,
      health: { mode: spine.mode, providers: spine.health, runtime: () => spine.runtimeSnapshot() },
    });
    servers.push(server);
    spines.push(spine);
    const bound = await listen(server, 0, '127.0.0.1');
    const session = await bootstrap(bound.url);
    const created = await fetch(`${bound.url}/api/projects`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ name: 'Durable' }),
    });
    expect(created.status).toBe(201);
    const project = (await created.json()) as { id: string };

    expect(spine.persistence).toBeInstanceOf(PostgresPersistence);
    await (spine.persistence as PostgresPersistence).tx.pool.end();
    const ready = await fetch(`${bound.url}/api/health/ready`);
    expect(ready.status).toBe(503);
    const readyBody = (await ready.json()) as { ready: boolean; dependencies: { postgres: string }; ha: boolean };
    expect(readyBody.ready).toBe(false);
    expect(readyBody.dependencies.postgres).toBe('error');
    expect(readyBody.ha).toBe(false);
    const listed = await fetch(`${bound.url}/api/projects`, { headers: authHeaders(session) });
    expect(listed.status).toBe(503);
    const listedBody = (await listed.json()) as { code?: string; error: string };
    expect(listedBody.code).toBe('persistence_unavailable');
    expect(listedBody.error).not.toMatch(/postgres:\/\//);

    await spine.close().catch(() => undefined);
    const restarted = await composeSpine({
      dataPath: join(dir, 'state.json'),
      mode: 'mock',
      persistence,
      casRoot: join(dir, 'cas'),
      env: {
        ATLAS_TENANT_ID: 'tenant_a',
        ATLAS_SESSION_SECRET: 'test-session-secret-not-for-production-use',
      },
    });
    spines.push(restarted);
    const restored = await restarted.projects?.get(
      { tenantId: restarted.tenantId, principalId: restarted.principalId },
      project.id,
    );
    expect(restored?.name).toBe('Durable');
  });
});
