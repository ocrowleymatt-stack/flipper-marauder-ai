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

async function startEstate() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-estate-'));
  const spine = await composeSpine({
    dataPath: join(dir, 'state.json'),
    mode: 'mock',
    persistence: memoryConfig('tenant_a'),
    casRoot: join(dir, 'cas'),
    streamDelayMs: 0,
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
    osint: spine.osint,
    investigation: spine.investigation,
    research: spine.research,
    websiteStudio: spine.websiteStudio,
    music: spine.music,
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

function auth(session: { cookie: string; csrf: string }) {
  return { cookie: session.cookie, 'x-atlas-csrf': session.csrf, 'content-type': 'application/json' };
}

describe('Dungeon estate host', () => {
  it('lists every migrated dungeon from the host catalogue', async () => {
    const { url } = await startEstate();
    const session = await bootstrap(url);
    const dungeons = (await (await fetch(`${url}/api/dungeons`, { headers: { cookie: session.cookie } })).json()) as Array<{
      id: string;
    }>;
    expect(dungeons.map((item) => item.id).sort()).toEqual(
      ['investigation', 'music', 'osint', 'privacy', 'research', 'website', 'writing'].sort(),
    );
  });

  it('runs OSINT, investigation, research, website, and music through platform jobs and CAS', async () => {
    const { url } = await startEstate();
    const session = await bootstrap(url);
    const project = (await (
      await fetch(`${url}/api/projects`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({ name: 'Estate' }),
      })
    ).json()) as { id: string };

    const scan = await fetch(`${url}/api/projects/${project.id}/osint/scans`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ kind: 'username', value: 'atlas-owner', synthesize: false }),
    });
    expect(scan.status).toBe(201);
    const osint = (await scan.json()) as { target: { id: string }; findings: Array<{ id: string }> };
    expect(osint.findings.length).toBeGreaterThan(0);

    const createdCase = await fetch(`${url}/api/projects/${project.id}/cases`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({
        title: 'Username case',
        question: 'Is this a person?',
        findingIds: osint.findings.map((item) => item.id),
      }),
    });
    expect(createdCase.status).toBe(201);
    const caseboard = (await createdCase.json()) as { id: string };
    const challenge = await fetch(`${url}/api/cases/${caseboard.id}/challenge`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ stance: 'challenger' }),
    });
    expect(challenge.status).toBe(201);

    await fetch(`${url}/api/projects/${project.id}/files`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ path: 'notes.md', text: 'A copper kettle sings on the stove.' }),
    });
    const files = (await (
      await fetch(`${url}/api/projects/${project.id}/files`, { headers: { cookie: session.cookie } })
    ).json()) as Array<{ id: string }>;
    const brief = await fetch(`${url}/api/projects/${project.id}/research`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ question: 'What sings?', fileIds: files.map((item) => item.id) }),
    });
    expect(brief.status).toBe(201);
    const research = (await brief.json()) as { id: string };
    const ran = await fetch(`${url}/api/research/${research.id}/run`, { method: 'POST', headers: auth(session), body: '{}' });
    expect(ran.status).toBe(200);

    const siteRes = await fetch(`${url}/api/projects/${project.id}/sites`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ name: 'Studio', brief: 'A page' }),
    });
    expect(siteRes.status).toBe(201);
    const site = (await siteRes.json()) as { id: string };
    const generated = await fetch(`${url}/api/sites/${site.id}/generate`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ brief: 'Accessible landing page.' }),
    });
    expect(generated.status).toBe(200);
    const preview = await fetch(`${url}/api/sites/${site.id}/preview`, { headers: { cookie: session.cookie } });
    expect(preview.headers.get('content-type')).toMatch(/text\/html/);
    const blocked = await fetch(`${url}/api/sites/${site.id}/promote`, { method: 'POST', headers: auth(session), body: '{}' });
    expect(blocked.status).toBe(404);
    const enabled = await fetch(`${url}/api/privacy/policy`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ patch: { repoWrite: true }, confirm: 'CONFIRM' }),
    });
    expect(enabled.status).toBe(200);
    const promoted = await fetch(`${url}/api/sites/${site.id}/promote`, { method: 'POST', headers: auth(session), body: '{}' });
    expect(promoted.status).toBe(200);

    const composition = await fetch(`${url}/api/projects/${project.id}/compositions`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ title: 'Copper', brief: 'Restrained theme' }),
    });
    expect(composition.status).toBe(201);
    const music = (await composition.json()) as { id: string };
    const composed = await fetch(`${url}/api/compositions/${music.id}/compose`, {
      method: 'POST',
      headers: auth(session),
      body: '{}',
    });
    expect(composed.status).toBe(200);
    const packet = (await composed.json()) as { status: string };
    expect(packet.status).toBe('completed');
  });

  it('does not treat conversation routes as estate failures', async () => {
    const { url } = await startEstate();
    const session = await bootstrap(url);
    const created = await fetch(`${url}/api/conversations`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ title: 'Thread' }),
    });
    expect(created.status).toBe(201);
  });
});
