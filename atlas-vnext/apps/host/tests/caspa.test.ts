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

async function startCaspa() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-caspa-'));
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
  const body = (await response.json()) as { csrfToken: string };
  return { cookie: response.headers.get('set-cookie') ?? '', csrf: body.csrfToken };
}

function auth(session: { cookie: string; csrf: string }) {
  return { cookie: session.cookie, 'x-atlas-csrf': session.csrf, 'content-type': 'application/json' };
}

async function readSse(response: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await response.text();
  const frames: Array<{ event: string; data: Record<string, unknown> }> = [];
  let currentEvent = 'message';
  for (const line of text.split('\n')) {
    if (line.startsWith('event: ')) currentEvent = line.slice(7).trim();
    else if (line.startsWith('data: ')) {
      frames.push({ event: currentEvent, data: JSON.parse(line.slice(6)) as Record<string, unknown> });
      currentEvent = 'message';
    }
  }
  return frames;
}

describe('Caspa writing dungeon host', () => {
  it('registers Caspa and creates a durable writing document from an instruction', async () => {
    const { url } = await startCaspa();
    const session = await bootstrap(url);
    const dungeons = (await (await fetch(`${url}/api/dungeons`, { headers: { cookie: session.cookie } })).json()) as Array<{
      id: string;
      slug: string;
    }>;
    expect(dungeons.some((item) => item.id === 'writing' && item.slug === 'caspa')).toBe(true);
    const project = (await (
      await fetch(`${url}/api/projects`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({ name: 'Book', dungeon: 'writing' }),
      })
    ).json()) as { id: string; dungeon: string };
    expect(project.dungeon).toBe('writing');
    const created = await fetch(`${url}/api/projects/${project.id}/documents`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ title: 'Chapter 1', instruction: 'A copper kettle' }),
    });
    expect(created.status).toBe(201);
    const document = (await created.json()) as { id: string; revision: number; projectId: string };
    expect(document.projectId).toBe(project.id);
    const stream = await fetch(`${url}/api/documents/${document.id}/generate`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({
        operation: 'create',
        instruction: 'Write a short chapter about a copper kettle.',
        expectedRevision: document.revision,
        fileIds: [],
      }),
    });
    const frames = await readSse(stream);
    expect(frames.some((frame) => frame.event === 'done')).toBe(true);
    const reloaded = (await (await fetch(`${url}/api/documents/${document.id}`, { headers: { cookie: session.cookie } })).json()) as {
      status: string;
      currentVersion: number;
      content: string;
    };
    expect(reloaded.status).toBe('committed');
    expect(reloaded.currentVersion).toBe(1);
    expect(reloaded.content.length).toBeGreaterThan(0);
    const versions = (await (await fetch(`${url}/api/documents/${document.id}/versions`, { headers: { cookie: session.cookie } })).json()) as Array<{
      version: number;
    }>;
    expect(versions).toHaveLength(1);
    const provenance = (await (await fetch(`${url}/api/documents/${document.id}/provenance`, { headers: { cookie: session.cookie } })).json()) as Array<{
      artefactId: string;
    }>;
    expect(provenance.length).toBeGreaterThan(0);
  });

  it('isolates documents, versions, projects, files, runs and mutations across tenants', async () => {
    const { url, spine } = await startCaspa();
    const sessionA = await bootstrap(url);
    const project = (await (
      await fetch(`${url}/api/projects`, {
        method: 'POST',
        headers: auth(sessionA),
        body: JSON.stringify({ name: 'Secret writing' }),
      })
    ).json()) as { id: string };
    const document = (await (
      await fetch(`${url}/api/projects/${project.id}/documents`, {
        method: 'POST',
        headers: auth(sessionA),
        body: JSON.stringify({ title: 'Secret' }),
      })
    ).json()) as { id: string; revision: number };
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
    for (const cap of ['artifact.read', 'artifact.write', 'project.read', 'file.read'] as const) {
      spine.authority.grantTo({ principalId: 'principal_b', tenantId: 'tenant_b', capability: cap });
    }
    const issuedB = await spine.auth.issueSession({ principalId: 'principal_b', tenantId: 'tenant_b' });
    const headersB = {
      cookie: spine.auth.cookieHeader(issuedB.session.id),
      'x-atlas-csrf': issuedB.csrfToken,
      'content-type': 'application/json',
    };

    const guessed = await fetch(`${url}/api/documents/${document.id}`, { headers: headersB });
    expect(guessed.status).toBe(404);
    expect((await guessed.json() as { error: string }).error).toBe('Permission denied.');
    for (const path of [
      `/api/documents/${document.id}/versions`,
      `/api/documents/${document.id}/provenance`,
      `/api/projects/${project.id}/documents`,
    ]) {
      const response = await fetch(`${url}${path}`, { headers: headersB });
      if (path.endsWith('/documents')) {
        expect(response.status).toBe(404);
      } else {
        expect(response.status).toBe(404);
      }
    }
    const mutate = await fetch(`${url}/api/documents/${document.id}/generate`, {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({ operation: 'rewrite', instruction: 'steal', expectedRevision: document.revision }),
    });
    const mutateFrames = await readSse(mutate);
    expect(mutateFrames.some((frame) => frame.event === 'error')).toBe(true);
    const restore = await fetch(`${url}/api/documents/${document.id}/restore`, {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({ version: 1, expectedRevision: document.revision }),
    });
    expect(restore.status).toBe(404);
    const rename = await fetch(`${url}/api/documents/${document.id}`, {
      method: 'PATCH',
      headers: headersB,
      body: JSON.stringify({ title: 'Stolen', expectedRevision: document.revision }),
    });
    expect(rename.status).toBe(404);
    const del = await fetch(`${url}/api/documents/${document.id}`, { method: 'DELETE', headers: headersB });
    expect(del.status).toBe(404);
    const stealFile = await fetch(`${url}/api/documents/${document.id}/generate`, {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({
        operation: 'rewrite',
        instruction: 'steal file',
        expectedRevision: document.revision,
        fileIds: ['fil_guessed'],
      }),
    });
    const stealFrames = await readSse(stealFile);
    expect(stealFrames.some((frame) => frame.event === 'error')).toBe(true);
  });

  it('requires CSRF and does not treat button presence as Authority', async () => {
    const { url } = await startCaspa();
    const session = await bootstrap(url);
    const project = (await (
      await fetch(`${url}/api/projects`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({ name: 'Auth' }),
      })
    ).json()) as { id: string };
    const noCsrf = await fetch(`${url}/api/projects/${project.id}/documents`, {
      method: 'POST',
      headers: { cookie: session.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Nope' }),
    });
    expect(noCsrf.status).toBe(403);
  });

  it('rejects stale edits and classified malformed/unauth requests', async () => {
    const { url } = await startCaspa();
    const unauth = await fetch(`${url}/api/dungeons`);
    expect(unauth.status).toBe(401);
    const session = await bootstrap(url);
    const project = (await (
      await fetch(`${url}/api/projects`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({ name: 'Concurrency' }),
      })
    ).json()) as { id: string };
    const document = (await (
      await fetch(`${url}/api/projects/${project.id}/documents`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({ title: 'Doc' }),
      })
    ).json()) as { id: string; revision: number };
    const stale = await fetch(`${url}/api/documents/${document.id}`, {
      method: 'PATCH',
      headers: auth(session),
      body: JSON.stringify({ title: 'Older client', expectedRevision: 0 }),
    });
    expect(stale.status).toBe(409);
    const malformed = await fetch(`${url}/api/documents/${document.id}/generate`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ operation: 'not-a-mode', instruction: 'x', expectedRevision: document.revision }),
    });
    expect(malformed.status).toBe(400);
    const [left, right] = await Promise.all([
      fetch(`${url}/api/documents/${document.id}`, {
        method: 'PATCH',
        headers: auth(session),
        body: JSON.stringify({ title: 'Left', expectedRevision: document.revision }),
      }),
      fetch(`${url}/api/documents/${document.id}`, {
        method: 'PATCH',
        headers: auth(session),
        body: JSON.stringify({ title: 'Right', expectedRevision: document.revision }),
      }),
    ]);
    const statuses = [left.status, right.status].sort();
    expect(statuses).toEqual([200, 409]);
    const reloaded = (await (await fetch(`${url}/api/documents/${document.id}`, { headers: { cookie: session.cookie } })).json()) as {
      title: string;
      revision: number;
    };
    expect(['Left', 'Right']).toContain(reloaded.title);
    expect(reloaded.revision).toBe(document.revision + 1);
  });

  it('grounds a writing run on selected files and returns backend provenance', async () => {
    const { url } = await startCaspa();
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
      body: JSON.stringify({ path: 'brief.md', text: 'The copper kettle is canonical.' }),
    });
    const file = (await uploaded.json()) as { id: string; contentHash: string };
    const document = (await (
      await fetch(`${url}/api/projects/${project.id}/documents`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({ title: 'Grounded' }),
      })
    ).json()) as { id: string; revision: number };
    const stream = await fetch(`${url}/api/documents/${document.id}/generate`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({
        operation: 'create',
        instruction: 'Use the brief.',
        expectedRevision: document.revision,
        fileIds: [file.id],
      }),
    });
    await readSse(stream);
    const provenance = (await (await fetch(`${url}/api/documents/${document.id}/provenance`, { headers: { cookie: session.cookie } })).json()) as Array<{
      sourceInputs: string[];
    }>;
    expect(provenance.some((entry) => entry.sourceInputs.includes(file.id) || entry.sourceInputs.includes(file.contentHash))).toBe(true);
  });

  it('reloads the committed document from the server and continues as a revision', async () => {
    const { url } = await startCaspa();
    const session = await bootstrap(url);
    const project = (await (
      await fetch(`${url}/api/projects`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({ name: 'Reload' }),
      })
    ).json()) as { id: string };
    const created = (await (
      await fetch(`${url}/api/projects/${project.id}/documents`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({ title: 'Durable' }),
      })
    ).json()) as { id: string; revision: number };
    await readSse(
      await fetch(`${url}/api/documents/${created.id}/generate`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({
          operation: 'create',
          instruction: 'Write a paragraph.',
          expectedRevision: created.revision,
        }),
      }),
    );
    const first = (await (await fetch(`${url}/api/documents/${created.id}`, { headers: { cookie: session.cookie } })).json()) as {
      currentVersion: number;
      revision: number;
      content: string;
      status: string;
    };
    expect(first.status).toBe('committed');
    expect(first.currentVersion).toBe(1);
    expect(first.content.length).toBeGreaterThan(0);
    await readSse(
      await fetch(`${url}/api/documents/${created.id}/generate`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({
          operation: 'continue',
          instruction: 'Add a sentence.',
          expectedRevision: first.revision,
        }),
      }),
    );
    const continued = (await (await fetch(`${url}/api/documents/${created.id}`, { headers: { cookie: session.cookie } })).json()) as {
      currentVersion: number;
    };
    expect(continued.currentVersion).toBe(2);
  });

  it('fail-closes Caspa routes for missing and revoked sessions without opening CORS', async () => {
    const { url, spine } = await startCaspa();
    const session = await bootstrap(url);
    const project = (await (
      await fetch(`${url}/api/projects`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({ name: 'Auth recon' }),
      })
    ).json()) as { id: string };
    const document = (await (
      await fetch(`${url}/api/projects/${project.id}/documents`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({ title: 'Secret' }),
      })
    ).json()) as { id: string };

    const missing = await fetch(`${url}/api/dungeons`, { headers: { origin: 'https://evil.example' } });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('access-control-allow-origin')).not.toBe('*');

    const listed = await fetch(`${url}/api/projects/${project.id}/documents`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(listed.status).toBe(401);

    const generate = await fetch(`${url}/api/documents/${document.id}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ operation: 'create', instruction: 'steal', expectedRevision: 0 }),
    });
    expect(generate.status).toBe(401);

    const cookie = /atlas_session=([^;]+)/.exec(session.cookie)?.[1];
    expect(cookie).toBeTruthy();
    await spine.auth.revoke(cookie!);

    const revokedDungeons = await fetch(`${url}/api/dungeons`, { headers: { cookie: session.cookie } });
    expect(revokedDungeons.status).toBe(401);
    const revokedDocs = await fetch(`${url}/api/projects/${project.id}/documents`, {
      headers: { cookie: session.cookie },
    });
    expect(revokedDocs.status).toBe(401);
    const revokedPatch = await fetch(`${url}/api/documents/${document.id}`, {
      method: 'PATCH',
      headers: auth(session),
      body: JSON.stringify({ title: 'stolen', expectedRevision: 1 }),
    });
    expect([401, 403]).toContain(revokedPatch.status);

    const preflight = await fetch(`${url}/api/documents/${document.id}`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'PATCH' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toMatch(/PATCH/);
    expect(preflight.headers.get('access-control-allow-methods')).toMatch(/DELETE/);
    expect(preflight.headers.get('access-control-allow-origin')).not.toBe('*');
    expect(preflight.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
  });

  it('keeps file-mode conversation routes working when Caspa writing is unwired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-caspa-file-'));
    const spine = await composeSpine({
      dataPath: join(dir, 'state.json'),
      mode: 'mock',
    });
    spines.push(spine);
    expect(spine.writing).toBeNull();
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
    });
    servers.push(server);
    const bound = await listen(server, 0, '127.0.0.1');
    const session = await bootstrap(bound.url);
    const projects = await fetch(`${bound.url}/api/projects`, { headers: { cookie: session.cookie } });
    expect(projects.status).toBe(503);
    const dungeons = await fetch(`${bound.url}/api/dungeons`, { headers: { cookie: session.cookie } });
    expect(dungeons.status).toBe(200);
    const docs = await fetch(`${bound.url}/api/projects/proj_x/documents`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ title: 'Nope' }),
    });
    expect(docs.status).toBe(503);
    const unavailable = (await docs.json()) as { code?: string };
    expect(unavailable.code).toBe('writing_unavailable');
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
});
