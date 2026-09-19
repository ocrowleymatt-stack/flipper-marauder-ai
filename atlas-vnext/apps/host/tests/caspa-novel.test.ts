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
  const dir = mkdtempSync(join(tmpdir(), 'atlas-caspa-novel-'));
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

async function createProject(url: string, session: { cookie: string; csrf: string }, name = 'Harbour') {
  const project = (await (
    await fetch(`${url}/api/projects`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ name, dungeon: 'writing' }),
    })
  ).json()) as { id: string };
  const document = (await (
    await fetch(`${url}/api/projects/${project.id}/documents`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ title: 'Chapter 1' }),
    })
  ).json()) as { id: string; revision: number; currentVersion: number; content: string };
  return { project, document };
}

describe('Caspa novelist host', () => {
  it('persists story bible, characters, world, and structure on the project', async () => {
    const { url } = await startCaspa();
    const session = await bootstrap(url);
    const { project } = await createProject(url, session);
    const bible = await fetch(`${url}/api/projects/${project.id}/story-bible`, {
      method: 'PUT',
      headers: auth(session),
      body: JSON.stringify({ payload: { premise: 'A singing kettle', genre: 'fable', tone: 'warm' } }),
    });
    expect(bible.status).toBe(200);
    const bibleBody = (await bible.json()) as { kind: string; payload: { premise: string } };
    expect(bibleBody.kind).toBe('story_bible');
    expect(bibleBody.payload.premise).toContain('kettle');
    const character = await fetch(`${url}/api/projects/${project.id}/characters`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ payload: { name: 'Mara', role: 'smuggler', voice: 'clipped' } }),
    });
    expect(character.status).toBe(201);
    const world = await fetch(`${url}/api/projects/${project.id}/world`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ payload: { name: 'Harbour', rules: 'Fog hides the quay.' } }),
    });
    expect(world.status).toBe(201);
    const structure = await fetch(`${url}/api/projects/${project.id}/structure`, {
      method: 'PUT',
      headers: auth(session),
      body: JSON.stringify({ payload: { chapters: [{ id: 'ch_1', title: 'Arrival', documentId: null, summary: '', scenes: [] }] } }),
    });
    expect(structure.status).toBe(200);
    const listed = (await (await fetch(`${url}/api/projects/${project.id}/characters`, { headers: { cookie: session.cookie } })).json()) as Array<{
      title: string;
    }>;
    expect(listed.some((row) => row.title === 'Mara')).toBe(true);
    const worlds = (await (await fetch(`${url}/api/projects/${project.id}/world`, { headers: { cookie: session.cookie } })).json()) as Array<{
      title: string;
    }>;
    expect(worlds.some((row) => row.title === 'Harbour')).toBe(true);
  });

  it('drafts a scene as a manuscript revision with creative lineage, not evidential source invention', async () => {
    const { url } = await startCaspa();
    const session = await bootstrap(url);
    const { project, document } = await createProject(url, session);
    await fetch(`${url}/api/projects/${project.id}/story-bible`, {
      method: 'PUT',
      headers: auth(session),
      body: JSON.stringify({ payload: { premise: 'A copper kettle sings' } }),
    });
    const stream = await fetch(`${url}/api/documents/${document.id}/generate`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({
        operation: 'draft_scene',
        instruction: 'Draft the harbour opening.',
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
    const lineage = (await (await fetch(`${url}/api/documents/${document.id}/lineage`, { headers: { cookie: session.cookie } })).json()) as Array<{
      kind: string;
      payload: { operation?: string };
    }>;
    expect(lineage.some((row) => row.kind === 'creative_lineage' && row.payload.operation === 'draft_scene')).toBe(true);
    const provenance = (await (await fetch(`${url}/api/documents/${document.id}/provenance`, { headers: { cookie: session.cookie } })).json()) as Array<{
      artefactId: string;
    }>;
    expect(provenance.length).toBeGreaterThan(0);
    expect(lineage[0]?.kind).not.toBe('provenance');
  });

  it('records critique findings without overwriting manuscript content', async () => {
    const { url } = await startCaspa();
    const session = await bootstrap(url);
    const { project, document } = await createProject(url, session);
    await readSse(
      await fetch(`${url}/api/documents/${document.id}/generate`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({
          operation: 'draft_scene',
          instruction: 'Write the scene.',
          expectedRevision: document.revision,
        }),
      }),
    );
    const drafted = (await (await fetch(`${url}/api/documents/${document.id}`, { headers: { cookie: session.cookie } })).json()) as {
      content: string;
      currentVersion: number;
      revision: number;
    };
    expect(drafted.content.length).toBeGreaterThan(0);
    await readSse(
      await fetch(`${url}/api/documents/${document.id}/generate`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({
          operation: 'critique',
          instruction: 'Critique reader tension.',
          expectedRevision: drafted.revision,
        }),
      }),
    );
    const after = (await (await fetch(`${url}/api/documents/${document.id}`, { headers: { cookie: session.cookie } })).json()) as {
      content: string;
      currentVersion: number;
      status: string;
    };
    expect(after.content).toBe(drafted.content);
    expect(after.currentVersion).toBe(drafted.currentVersion);
    expect(after.status).toBe('committed');
    const listed = (await (await fetch(`${url}/api/projects/${project.id}/continuity`, { headers: { cookie: session.cookie } })).json()) as Array<{
      kind: string;
    }>;
    expect(listed.some((row) => row.kind === 'critique')).toBe(true);
  });

  it('rejects stale manuscript writes and restores as a new version', async () => {
    const { url } = await startCaspa();
    const session = await bootstrap(url);
    const { document } = await createProject(url, session);
    await readSse(
      await fetch(`${url}/api/documents/${document.id}/generate`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({
          operation: 'continue_scene',
          instruction: 'Continue.',
          expectedRevision: document.revision,
        }),
      }),
    );
    const latest = (await (await fetch(`${url}/api/documents/${document.id}`, { headers: { cookie: session.cookie } })).json()) as {
      revision: number;
      currentVersion: number;
    };
    const stale = await fetch(`${url}/api/documents/${document.id}/edit`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ text: 'stale overwrite', expectedRevision: document.revision }),
    });
    expect(stale.status).toBe(409);
    const restore = await fetch(`${url}/api/documents/${document.id}/restore`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ version: 1, expectedRevision: latest.revision }),
    });
    expect(restore.status).toBe(200);
    const restored = (await restore.json()) as { currentVersion: number };
    expect(restored.currentVersion).toBeGreaterThan(latest.currentVersion);
  });

  it('enforces Authority and tenant isolation on novelist routes', async () => {
    const { url, spine } = await startCaspa();
    const sessionA = await bootstrap(url);
    const { project, document } = await createProject(url, sessionA, 'Secret novel');
    await fetch(`${url}/api/projects/${project.id}/story-bible`, {
      method: 'PUT',
      headers: auth(sessionA),
      body: JSON.stringify({ payload: { premise: 'secret' } }),
    });
    expect((await fetch(`${url}/api/projects/${project.id}/story-bible`)).status).toBe(401);

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
    for (const path of [
      `/api/projects/${project.id}/story-bible`,
      `/api/projects/${project.id}/characters`,
      `/api/projects/${project.id}/structure`,
      `/api/projects/${project.id}/continuity`,
      `/api/documents/${document.id}/lineage`,
    ]) {
      const response = await fetch(`${url}${path}`, { headers: headersB });
      expect(response.status).toBe(404);
    }
  });
});
