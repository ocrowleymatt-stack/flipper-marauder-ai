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

async function startWorkbench() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-workbench-'));
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
    writing: spine.writing,
    tenantId: spine.tenantId,
    principalId: spine.principalId,
    maxRequestBytes: spine.limits.maxRequestBytes,
    maxUploadBytes: spine.limits.maxUploadBytes,
  });
  servers.push(server);
  const bound = await listen(server, 0, '127.0.0.1');
  return { ...bound, spine, dir };
}

async function bootstrap(url: string) {
  const response = await fetch(`${url}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = (await response.json()) as { csrfToken: string; principal: { id: string } };
  return {
    cookie: response.headers.get('set-cookie') ?? '',
    csrf: body.csrfToken,
    principal: body.principal,
  };
}

function auth(session: { cookie: string; csrf: string }, extra?: Record<string, string>) {
  return {
    cookie: session.cookie,
    'x-atlas-csrf': session.csrf,
    'content-type': 'application/json',
    ...extra,
  };
}

async function readSse(response: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await response.text();
  const frames: Array<{ event: string; data: unknown }> = [];
  let currentEvent = 'message';
  for (const line of text.split('\n')) {
    if (line.startsWith('event: ')) currentEvent = line.slice(7).trim();
    else if (line.startsWith('data: ')) {
      frames.push({ event: currentEvent, data: JSON.parse(line.slice(6)) });
      currentEvent = 'message';
    }
  }
  return frames;
}

describe('Atlas Workbench host', () => {
  it('bootstraps a session from the host principal and ignores a client tenant id', async () => {
    const { url } = await startWorkbench();
    const forged = await fetch(`${url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant_attacker' }),
    });
    expect(forged.status).toBe(403);
    const ok = await fetch(`${url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { authenticated: boolean; csrfToken: string };
    expect(body.authenticated).toBe(true);
    expect(body.csrfToken).toBeTruthy();
  });

  it('creates a project, conversation, streamed turn, and restores it after reload', async () => {
    const { url } = await startWorkbench();
    const session = await bootstrap(url);
    const created = await fetch(`${url}/api/projects`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ name: 'Caspa-ready notes' }),
    });
    expect(created.status).toBe(201);
    const project = (await created.json()) as { id: string; name: string };
    const conversationRes = await fetch(`${url}/api/projects/${project.id}/conversations`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({}),
    });
    const conversation = (await conversationRes.json()) as { id: string; projectId: string };
    expect(conversation.projectId).toBe(project.id);
    const stream = await fetch(`${url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ content: 'hello workbench', capability: 'nexus/fast' }),
    });
    const frames = await readSse(stream);
    expect(frames.some((frame) => frame.event === 'done')).toBe(true);
    const snapshot = await fetch(`${url}/api/conversations/${conversation.id}`, { headers: { cookie: session.cookie } });
    const body = (await snapshot.json()) as {
      messages: Array<{ role: string; content: string }>;
      executions: Array<{ status: string; id: string }>;
    };
    expect(body.messages).toHaveLength(2);
    expect(body.executions[0]?.status).toBe('completed');
    const inspected = await fetch(`${url}/api/executions/${body.executions[0]!.id}`, { headers: { cookie: session.cookie } });
    const run = (await inspected.json()) as { execution: { providerSwitchDisguised: boolean; selectedProvider: string } };
    expect(run.execution.providerSwitchDisguised).toBe(false);
    expect(run.execution.selectedProvider).toBeTruthy();
  });

  it('isolates projects, files, sessions and guessed ids across tenants', async () => {
    const { url, spine } = await startWorkbench();
    const sessionA = await bootstrap(url);
    const project = (await (
      await fetch(`${url}/api/projects`, {
        method: 'POST',
        headers: auth(sessionA),
        body: JSON.stringify({ name: 'Secret A' }),
      })
    ).json()) as { id: string };
    await fetch(`${url}/api/projects/${project.id}/files`, {
      method: 'POST',
      headers: auth(sessionA),
      body: JSON.stringify({ path: 'secret.md', text: 'tenant A only' }),
    });

    await spine.persistence!.ensureTenant({ id: 'tenant_b', name: 'B' });
    await spine.persistence!.ensurePrincipal({ id: 'principal_b', displayName: 'B' });
    await spine.persistence!.forActor({ tenantId: 'tenant_b', principalId: 'principal_b' }).directory.putTenantMembership({
      principalId: 'principal_b',
      tenantId: 'tenant_b',
      role: 'member',
      capabilities: [],
      createdAt: new Date().toISOString(),
    });
    spine.authority.grantMembership('principal_b', 'tenant_b');
    const issuedB = await spine.auth.issueSession({ principalId: 'principal_b', tenantId: 'tenant_b' });
    const headersB = {
      cookie: spine.auth.cookieHeader(issuedB.session.id),
      'x-atlas-csrf': issuedB.csrfToken,
      'content-type': 'application/json',
    };

    const hiddenProject = await fetch(`${url}/api/projects/${project.id}`, { headers: headersB });
    expect(hiddenProject.status).toBe(404);
    const listed = (await (await fetch(`${url}/api/projects`, { headers: headersB })).json()) as Array<{ id: string }>;
    expect(listed.some((item) => item.id === project.id)).toBe(false);
    const conversations = await fetch(`${url}/api/conversations`, { headers: headersB });
    expect(await conversations.json()).toEqual([]);
    const guessedTool = await fetch(`${url}/api/tools/tinv_guessed`, { headers: headersB });
    expect(guessedTool.status).toBe(404);
    expect((await guessedTool.json() as { error: string }).error).toBe('Permission denied.');
    const approveGuess = await fetch(`${url}/api/tools/tinv_guessed/approve`, {
      method: 'POST',
      headers: headersB,
      body: '{}',
    });
    expect(approveGuess.status).toBe(404);
  });

  it('stores files in CAS, attaches them, and returns backend provenance only', async () => {
    const { url } = await startWorkbench();
    const session = await bootstrap(url);
    const project = (await (
      await fetch(`${url}/api/projects`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({ name: 'Sources' }),
      })
    ).json()) as { id: string };
    const uploaded = await fetch(`${url}/api/projects/${project.id}/files`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ path: 'brief.md', text: 'The copper kettle is the source of truth.' }),
    });
    expect(uploaded.status).toBe(201);
    const file = (await uploaded.json()) as { id: string; contentHash: string; path: string };
    expect(file.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(file)).not.toMatch(/The copper kettle/);
    const conversation = (await (
      await fetch(`${url}/api/projects/${project.id}/conversations`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };
    await fetch(`${url}/api/files/${file.id}/attach`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ conversationId: conversation.id }),
    });
    const context = (await (
      await fetch(`${url}/api/projects/${project.id}/context?query=kettle&conversationId=${conversation.id}`, {
        headers: { cookie: session.cookie },
      })
    ).json()) as { citations: Array<{ confidence: string; path: string | null }>; slices: Array<{ text: string }> };
    expect(context.citations.every((item) => item.confidence === 'sourced' || item.confidence === 'unknown')).toBe(true);
    expect(context.slices.some((slice) => slice.text.includes('copper kettle'))).toBe(true);
  });

  it('requires CSRF and session Authority for approve/deny and does not treat button presence as permission', async () => {
    const { url, spine } = await startWorkbench();
    const session = await bootstrap(url);
    const pending = await spine.tools.invoke(
      { tenantId: spine.tenantId, principalId: spine.principalId },
      { toolId: 'fs.write', arguments: { path: 'out.txt', content: 'x' } },
    );
    expect(pending.invocation.status).toBe('awaiting_approval');
    const noCsrf = await fetch(`${url}/api/tools/${pending.invocation.id}/approve`, {
      method: 'POST',
      headers: { cookie: session.cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(noCsrf.status).toBe(403);
    const denied = await fetch(`${url}/api/tools/${pending.invocation.id}/deny`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ reason: 'no' }),
    });
    expect(denied.status).toBe(200);
    const body = (await denied.json()) as { invocation: { status: string } };
    expect(body.invocation.status).toBe('denied');
    const listed = (await (
      await fetch(`${url}/api/approvals`, { headers: { cookie: session.cookie } })
    ).json()) as Array<{ id: string }>;
    expect(listed.some((item) => item.id === pending.invocation.id)).toBe(false);
  });

  it('returns classified errors for unauthorised, missing and malformed requests', async () => {
    const { url } = await startWorkbench();
    const unauth = await fetch(`${url}/api/projects`);
    expect(unauth.status).toBe(401);
    const session = await bootstrap(url);
    const missing = await fetch(`${url}/api/projects/proj_missing`, { headers: { cookie: session.cookie } });
    expect(missing.status).toBe(404);
    const malformed = await fetch(`${url}/api/projects`, {
      method: 'POST',
      headers: auth(session),
      body: 'not-json',
    });
    expect(malformed.status).toBe(400);
    const production = await fetch(`${url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant_a' }),
    });
    expect([201, 403]).toContain(production.status);
  });

  it('refuses production session bootstrap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-workbench-prod-'));
    const spine = await composeSpine({
      dataPath: join(dir, 'state.json'),
      mode: 'mock',
      persistence: memoryConfig('tenant_a'),
      casRoot: join(dir, 'cas'),
    });
    spines.push(spine);
    const server = createHost({
      runtime: spine.runtime,
      auth: spine.auth,
      tools: spine.tools,
      projects: spine.projects,
      files: spine.files,
      context: spine.context,
      tenantId: spine.tenantId,
      principalId: spine.principalId,
      production: true,
    });
    servers.push(server);
    const bound = await listen(server, 0, '127.0.0.1');
    const response = await fetch(`${bound.url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(401);
  });

  it('rejects missing sessions on conversation routes when auth is configured', async () => {
    const { url } = await startWorkbench();
    const session = await bootstrap(url);
    const created = await fetch(`${url}/api/conversations`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ title: 'secret thread' }),
    });
    expect(created.status).toBe(201);
    const conversation = (await created.json()) as { id: string };

    const listed = await fetch(`${url}/api/conversations`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(listed.status).toBe(401);
    expect(listed.headers.get('access-control-allow-origin')).not.toBe('*');

    const snapshot = await fetch(`${url}/api/conversations/${conversation.id}`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(snapshot.status).toBe(401);

    const turn = await fetch(`${url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ content: 'steal', capability: 'nexus/fast' }),
    });
    expect(turn.status).toBe(401);

    const cancel = await fetch(`${url}/api/executions/ex_guessed/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(cancel.status).toBe(401);

    const allowed = await fetch(`${url}/api/conversations`, { headers: { cookie: session.cookie } });
    expect(allowed.status).toBe(200);
    const rows = (await allowed.json()) as Array<{ id: string }>;
    expect(rows.some((item) => item.id === conversation.id)).toBe(true);

    const reflected = await fetch(`${url}/api/conversations`, {
      headers: { cookie: session.cookie, origin: 'https://workbench.example' },
    });
    expect(reflected.headers.get('access-control-allow-origin')).not.toBe('https://workbench.example');

    const csrfTurn = await fetch(`${url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { cookie: session.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'no csrf', capability: 'nexus/fast' }),
    });
    expect(csrfTurn.status).toBe(403);
  });

  it('treats revoked session cookies as signed out and allows a fresh local bootstrap', async () => {
    const { url, spine } = await startWorkbench();
    const session = await bootstrap(url);
    const cookie = /atlas_session=([^;]+)/.exec(session.cookie)?.[1];
    expect(cookie).toBeTruthy();
    await spine.auth.revoke(cookie!);

    const probe = await fetch(`${url}/api/session`, { headers: { cookie: session.cookie } });
    expect(probe.status).toBe(200);
    const body = (await probe.json()) as { authenticated: boolean; bootstrapAllowed: boolean };
    expect(body.authenticated).toBe(false);
    expect(body.bootstrapAllowed).toBe(true);
    expect(probe.headers.get('set-cookie') ?? '').toMatch(/Max-Age=0/i);

    const issued = await fetch(`${url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookie },
      body: '{}',
    });
    expect(issued.status).toBe(201);
    const next = (await issued.json()) as { authenticated: boolean; csrfToken: string };
    expect(next.authenticated).toBe(true);
    expect(next.csrfToken).toBeTruthy();
  });

  it('keeps file-mode conversation routes session-bound and does not require projects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-workbench-file-'));
    const spine = await composeSpine({
      dataPath: join(dir, 'state.json'),
      mode: 'mock',
    });
    spines.push(spine);
    expect(spine.projects).toBeNull();
    const server = createHost({
      runtime: spine.runtime,
      auth: spine.auth,
      tools: spine.tools,
      projects: spine.projects,
      files: spine.files,
      context: spine.context,
      tenantId: spine.tenantId,
      principalId: spine.principalId,
    });
    servers.push(server);
    const bound = await listen(server, 0, '127.0.0.1');
    const session = await bootstrap(bound.url);
    const projects = await fetch(`${bound.url}/api/projects`, { headers: { cookie: session.cookie } });
    expect(projects.status).toBe(503);
    const listed = await fetch(`${bound.url}/api/conversations`, { headers: { cookie: session.cookie } });
    expect(listed.status).toBe(200);
    const created = await fetch(`${bound.url}/api/conversations`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ title: 'file mode' }),
    });
    expect(created.status).toBe(201);
    const anonymous = await fetch(`${bound.url}/api/conversations`);
    expect(anonymous.status).toBe(401);
  });

  it('reflects an explicit origin allowlist with credentials and never uses * with auth', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-workbench-cors-'));
    const spine = await composeSpine({
      dataPath: join(dir, 'state.json'),
      mode: 'mock',
      persistence: memoryConfig('tenant_a'),
      casRoot: join(dir, 'cas'),
    });
    spines.push(spine);
    const server = createHost({
      runtime: spine.runtime,
      auth: spine.auth,
      tenantId: spine.tenantId,
      principalId: spine.principalId,
      allowedOrigins: ['https://workbench.example'],
    });
    servers.push(server);
    const bound = await listen(server, 0, '127.0.0.1');
    const ok = await fetch(`${bound.url}/api/session`, {
      headers: { origin: 'https://workbench.example' },
    });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://workbench.example');
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
    const evil = await fetch(`${bound.url}/api/session`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.headers.get('access-control-allow-origin')).not.toBe('*');
    expect(evil.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
  });
});
