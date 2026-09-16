import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { PersistenceConfig } from '@atlas-vnext/persistence';
import { composeSpine, createHost, grantSideEffects, listen, type Spine } from '../src/index.ts';

const servers: Server[] = [];
const spines: Spine[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
  await Promise.all(spines.splice(0).map((spine) => spine.close()));
});

function memoryConfig(tenantId: string): PersistenceConfig {
  return {
    mode: 'memory',
    production: false,
    databaseUrl: null,
    poolMax: 4,
    idleTimeoutMs: 10_000,
    connectionTimeoutMs: 5_000,
    statementTimeoutMs: 30_000,
    filePath: null,
    defaultTenantId: tenantId,
  };
}

async function startPrivacy() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-privacy-'));
  const spine = await composeSpine({
    dataPath: join(dir, 'state.json'),
    mode: 'mock',
    persistence: memoryConfig('tenant_a'),
    casRoot: join(dir, 'cas'),
  });
  grantSideEffects(spine.authority, spine.principalId, spine.tenantId);
  spines.push(spine);
  const server = createHost({
    runtime: spine.runtime,
    auth: spine.auth,
    tools: spine.tools,
    projects: spine.projects,
    files: spine.files,
    context: spine.context,
    persistence: spine.persistence,
    privacy: spine.privacy,
    tenantId: spine.tenantId,
    principalId: spine.principalId,
    flags: spine.flags,
    killSwitches: spine.killSwitches,
    resources: spine.resources,
    maxRequestBytes: spine.limits.maxRequestBytes,
    maxUploadBytes: spine.limits.maxUploadBytes,
    timeouts: spine.timeouts,
  });
  servers.push(server);
  const bound = await listen(server, 0, '127.0.0.1');
  return { ...bound, spine };
}

async function bootstrap(url: string) {
  const response = await fetch(`${url}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = (await response.json()) as { csrfToken: string };
  return { cookie: response.headers.get('set-cookie') ?? '', csrf: body.csrfToken };
}

function auth(session: { cookie: string; csrf: string }, extra: Record<string, string> = {}) {
  return { cookie: session.cookie, 'x-atlas-csrf': session.csrf, 'content-type': 'application/json', ...extra };
}

describe('Privacy & Safety host', () => {
  it('is owner-only and requires step-up for consequential policy', async () => {
    const { url, spine } = await startPrivacy();
    const owner = await bootstrap(url);
    const missing = await fetch(`${url}/api/privacy/effective`);
    expect(missing.status).toBe(401);
    const effective = await fetch(`${url}/api/privacy/effective`, { headers: { cookie: owner.cookie } });
    expect(effective.status).toBe(200);
    const viewed = (await effective.json()) as { modelContext: Record<string, unknown> };
    expect(viewed.modelContext).not.toHaveProperty('secrets');
    const unconfirmed = await fetch(`${url}/api/privacy/policy`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ patch: { networkAccess: 'none' } }),
    });
    expect(unconfirmed.status).toBe(403);
    const confirmed = await fetch(`${url}/api/privacy/policy`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ patch: { networkAccess: 'none' }, confirm: 'CONFIRM' }),
    });
    expect(confirmed.status).toBe(200);
    const modelGrant = await fetch(`${url}/api/privacy/policy`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ patch: { repoWrite: true }, confirm: 'CONFIRM', proposedByModel: true }),
    });
    expect(modelGrant.status).toBe(404);
    expect(((await modelGrant.json()) as { error: string }).error).toBe('Permission denied.');

    await spine.persistence!.ensurePrincipal({ id: 'principal_intruder', displayName: 'Intruder' });
    await spine.persistence!.forActor({ tenantId: spine.tenantId, principalId: 'principal_intruder' }).directory.putTenantMembership({
      principalId: 'principal_intruder',
      tenantId: spine.tenantId,
      role: 'member',
      capabilities: ['privacy.view', 'privacy.configure'],
      createdAt: new Date().toISOString(),
    });
    spine.authority.grantMembership('principal_intruder', spine.tenantId);
    spine.authority.grantTo({ principalId: 'principal_intruder', tenantId: spine.tenantId, capability: 'privacy.view' });
    spine.authority.grantTo({ principalId: 'principal_intruder', tenantId: spine.tenantId, capability: 'privacy.configure' });
    const issued = await spine.auth.issueSession({ principalId: 'principal_intruder', tenantId: spine.tenantId });
    const intruder = {
      cookie: spine.auth.cookieHeader(issued.session.id),
      csrf: issued.csrfToken,
    };
    const spoofed = await fetch(`${url}/api/privacy/effective`, {
      headers: auth(intruder, { 'x-atlas-tenant': 'tenant_a', 'x-atlas-role': 'owner' }),
    });
    expect(spoofed.status).toBe(404);
    expect(((await spoofed.json()) as { error: string }).error).toBe('Permission denied.');
    const escalate = await fetch(`${url}/api/privacy/policy`, {
      method: 'POST',
      headers: auth(intruder),
      body: JSON.stringify({ patch: { autonomyCeiling: 'act', repoWrite: true }, confirm: 'CONFIRM' }),
    });
    expect(escalate.status).toBe(404);
    const proposal = await fetch(`${url}/api/privacy/proposals`, {
      method: 'POST',
      headers: auth(intruder),
      body: JSON.stringify({ patch: { telemetry: 'off' } }),
    });
    expect(proposal.status).toBe(201);
    const created = (await proposal.json()) as { id: string };
    const implicitApprove = await fetch(`${url}/api/privacy/proposals/${created.id}/decide`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({}),
    });
    expect(implicitApprove.status).toBe(400);
    const denied = await fetch(`${url}/api/privacy/proposals/${created.id}/decide`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ status: 'denied' }),
    });
    expect(denied.status).toBe(200);
    const audit = await fetch(`${url}/api/privacy/audit`, { headers: { cookie: owner.cookie } });
    expect(audit.status).toBe(200);
  });
});
