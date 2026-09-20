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

async function startHost() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-wave5-'));
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
    login: spine.login,
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
  return {
    cookie: session.cookie,
    'x-atlas-csrf': session.csrf,
    'content-type': 'application/json',
  };
}

async function assistantText(response: Response): Promise<string> {
  const text = await response.text();
  const chunks: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = JSON.parse(line.slice(6)) as {
      type?: string;
      text?: string;
      message?: { content?: string; role?: string };
    };
    if (payload.type === 'assistant.completed' && payload.text) return payload.text;
    if (payload.type === 'assistant.delta' && payload.text) chunks.push(payload.text);
    if (payload.type === 'message' && payload.message?.role === 'assistant' && payload.message.content) {
      chunks.push(payload.message.content);
    }
  }
  return chunks.join('');
}

describe('Wave 5 Website Studio recovery', () => {
  it('builds a circus site from chat, stores CAS HTML, and revises the same artifact', async () => {
    const { url } = await startHost();
    const session = await bootstrap(url);
    const project = (await (
      await fetch(`${url}/api/projects`, { method: 'POST', headers: auth(session), body: JSON.stringify({ name: 'Wave5' }) })
    ).json()) as { id: string };
    const conversation = (await (
      await fetch(`${url}/api/projects/${project.id}/conversations`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };

    const response = await fetch(`${url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({
        content: 'Build a website about a neighbourhood circus with tents, tickets, and cocoa.',
        capability: 'nexus/fast',
      }),
    });
    expect(response.ok).toBe(true);
    const reply = await assistantText(response);
    expect(reply).toMatch(/^Website:/);
    expect(reply).toMatch(/circus/i);
    expect(reply).not.toMatch(/content filter/i);
    const siteId = reply.match(/^Site:\s+(site_\S+)/m)?.[1];
    expect(siteId).toBeTruthy();

    const snapshot = (await (await fetch(`${url}/api/conversations/${conversation.id}`, { headers: { cookie: session.cookie } })).json()) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(snapshot.messages.some((message) => message.role === 'assistant' && message.content.includes(siteId!))).toBe(true);

    const preview = await fetch(`${url}/api/sites/${siteId}/preview`, { headers: { cookie: session.cookie } });
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toMatch(/text\/html/);
    expect(preview.headers.get('content-security-policy')).toMatch(/sandbox/);
    const html = await preview.text();
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).toMatch(/circus/i);
    expect(html).not.toMatch(/<script/i);

    const files = (await (await fetch(`${url}/api/projects/${project.id}/files`, { headers: { cookie: session.cookie } })).json()) as Array<{
      path: string;
      origin?: string;
    }>;
    expect(files.some((file) => file.path === `sites/${siteId}/index.html`)).toBe(true);

    const follow = await fetch(`${url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ content: 'Make the hero shorter.', capability: 'nexus/fast' }),
    });
    expect(follow.ok).toBe(true);
    const revised = await assistantText(follow);
    expect(revised).toMatch(/Revision: 2/);
    expect(revised).toContain(siteId);

    const unauth = await fetch(`${url}/api/sites/${siteId}/preview`);
    expect([401, 403]).toContain(unauth.status);
  });

  it('does not steal research, writing, or OSINT questions', async () => {
    const { url } = await startHost();
    const session = await bootstrap(url);
    const project = (await (
      await fetch(`${url}/api/projects`, { method: 'POST', headers: auth(session), body: JSON.stringify({ name: 'Wave5R' }) })
    ).json()) as { id: string };
    const conversation = (await (
      await fetch(`${url}/api/projects/${project.id}/conversations`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };

    const research = await fetch(`${url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({
        content: 'Research the history of the World Wide Web using multiple independent sources.',
        capability: 'nexus/fast',
        tools: true,
      }),
    });
    expect(research.ok).toBe(true);
    const researchReply = await assistantText(research);
    expect(researchReply).toMatch(/Researching:/i);
    expect(researchReply).not.toMatch(/^Website:/);

    const writing = await fetch(`${url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({
        content: 'Write a 500-word scene about a lighthouse keeper hearing a voice from the fog.',
        capability: 'nexus/fast',
      }),
    });
    expect(writing.ok).toBe(true);
    expect(await assistantText(writing)).toMatch(/^Writing:/);
  });

  it('creates a new site for a new build ask and regenerates the conversation-bound site', async () => {
    const { url } = await startHost();
    const session = await bootstrap(url);
    const project = (await (
      await fetch(`${url}/api/projects`, { method: 'POST', headers: auth(session), body: JSON.stringify({ name: 'Wave5Id' }) })
    ).json()) as { id: string };
    const firstConversation = (await (
      await fetch(`${url}/api/projects/${project.id}/conversations`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };
    const first = await assistantText(
      await fetch(`${url}/api/conversations/${firstConversation.id}/messages`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({
          content: 'Build a website about a neighbourhood circus with tents, tickets, and cocoa.',
          capability: 'nexus/fast',
        }),
      }),
    );
    const firstSite = first.match(/^Site:\s+(site_\S+)/m)?.[1];
    expect(firstSite).toBeTruthy();

    const secondConversation = (await (
      await fetch(`${url}/api/projects/${project.id}/conversations`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };
    const second = await assistantText(
      await fetch(`${url}/api/conversations/${secondConversation.id}/messages`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({
          content: 'Create a landing page for the harbour bakery.',
          capability: 'nexus/fast',
        }),
      }),
    );
    const secondSite = second.match(/^Site:\s+(site_\S+)/m)?.[1];
    expect(secondSite).toBeTruthy();
    expect(secondSite).not.toBe(firstSite);

    const regenerated = await assistantText(
      await fetch(`${url}/api/conversations/${firstConversation.id}/messages`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({ content: 'Regenerate the site', capability: 'nexus/fast' }),
      }),
    );
    expect(regenerated).toContain(firstSite);
    expect(regenerated).not.toContain(secondSite);

    const unauthGenerate = await fetch(`${url}/api/sites/${firstSite}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief: 'steal' }),
    });
    expect([401, 403]).toContain(unauthGenerate.status);
  });
});
