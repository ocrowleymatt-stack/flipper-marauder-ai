import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { InspectedSource, SourceInspectPort } from '@atlas-vnext/contracts';
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

function octocatInspect(): SourceInspectPort {
  return {
    async inspect(input: { url: string }): Promise<InspectedSource> {
      const url = input.url;
      if (/127\.0\.0\.1|localhost|10\.|192\.168\.|169\.254\./i.test(url)) {
        throw new Error('Private or reserved network addresses are not permitted.');
      }
      let status = 404;
      let text = 'page not found';
      if (url.includes('github.com/octocat')) {
        status = 200;
        text = 'The Octocat GitHub profile repositories';
      } else if (url.includes('gitlab.com/octocat')) {
        status = 200;
        text = 'octocat GitLab profile';
      } else if (url.includes('example.com')) {
        status = 200;
        text = 'Example Domain This domain is for use in illustrative examples in documents.';
      } else if (url.includes('web.archive.org')) {
        status = 200;
        text = '[["urlkey","timestamp"],["com,example)/","20200101000000"]]';
      } else if (url.includes('news.ycombinator.com')) {
        status = 200;
        text = 'No such user.';
      }
      return {
        requestedUrl: url,
        finalUrl: url,
        status,
        ok: status >= 200 && status < 300,
        contentType: 'text/html',
        text,
        contentHash: createHash('sha256').update(text).digest('hex'),
        fetchedAt: '2026-09-19T17:00:00.000Z',
        truncated: false,
      };
    },
  };
}

async function startHost() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-wave2-'));
  const spine = await composeSpine({
    dataPath: join(dir, 'state.json'),
    mode: 'mock',
    persistence: memoryConfig('tenant_a'),
    casRoot: join(dir, 'cas'),
    streamDelayMs: 0,
    osintInspect: octocatInspect(),
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
    const payload = JSON.parse(line.slice(6)) as { type?: string; text?: string; message?: { content?: string; role?: string } };
    if (payload.type === 'assistant.completed' && payload.text) return payload.text;
    if (payload.type === 'assistant.delta' && payload.text) chunks.push(payload.text);
    if (payload.type === 'message' && payload.message?.role === 'assistant' && payload.message.content) {
      chunks.push(payload.message.content);
    }
  }
  return chunks.join('');
}

describe('Wave 2 OSINT conversation and estate', () => {
  it('returns evidence-backed OSINT to the requesting chat and resolves follow-ups', async () => {
    const { url, spine } = await startHost();
    const session = await bootstrap(url);
    const project = (await (
      await fetch(`${url}/api/projects`, { method: 'POST', headers: auth(session), body: JSON.stringify({ name: 'Wave2' }) })
    ).json()) as { id: string };
    const conversation = (await (
      await fetch(`${url}/api/projects/${project.id}/conversations`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };

    const send = async (content: string) => {
      const response = await fetch(`${url}/api/conversations/${conversation.id}/messages`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({ content, capability: 'nexus/fast', tools: true }),
      });
      expect(response.ok).toBe(true);
      return assistantText(response);
    };

    const report = await send('Run OSINT on octocat');
    expect(report).toMatch(/OSINT username scan of `octocat`/);
    expect(report).toMatch(/GitHub/);
    expect(report).toMatch(/Strongest finding:/);
    expect(report).toMatch(/https:\/\/github\.com\/octocat/);
    expect(report).toMatch(/Negative presence checks/);
    expect(report).toMatch(/not configured/i);

    const strongest = await send('Which of those findings is strongest?');
    expect(strongest).toMatch(/strongest finding/i);
    expect(strongest).toMatch(/GitHub/);

    const sources = await send('Which sources support it?');
    expect(sources).toMatch(/github\.com\/octocat/i);

    const second = await send('Open the second one.');
    expect(second).toMatch(/id=/);

    const snap = await fetch(`${url}/api/conversations/${conversation.id}`, { headers: { cookie: session.cookie } });
    expect(snap.status).toBe(200);
    const body = (await snap.json()) as { messages: Array<{ content: string }> };
    expect(body.messages.some((row) => /octocat/.test(row.content))).toBe(true);

    const records = await spine.persistence
      ?.forActor({ tenantId: spine.tenantId, principalId: spine.principalId })
      .dungeonRecords.list(
        { tenantId: spine.tenantId, principalId: spine.principalId },
        { workspaceId: project.id, dungeon: 'osint', kind: 'target' },
      );
    expect(records?.[0]?.conversationId).toBe(conversation.id);
    expect(records?.[0]?.payload.reportText).toMatch(/GitHub/);
  });

  it('accepts url targets, denies localhost, and hides guessed finding ids', async () => {
    const { url } = await startHost();
    const session = await bootstrap(url);
    const project = (await (
      await fetch(`${url}/api/projects`, { method: 'POST', headers: auth(session), body: JSON.stringify({ name: 'Wave2b' }) })
    ).json()) as { id: string };

    const page = await fetch(`${url}/api/projects/${project.id}/osint/scans`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ kind: 'url', value: 'https://example.com/', synthesize: false }),
    });
    expect(page.status).toBe(201);
    const scanned = (await page.json()) as {
      target: { id: string; payload: { reportText?: string } };
      findings: Array<{ id: string; payload: Record<string, unknown> }>;
    };
    expect(scanned.findings.some((item) => item.payload.status === 'confirmed' && String(item.payload.url ?? '').includes('example.com'))).toBe(
      true,
    );

    const denied = await fetch(`${url}/api/projects/${project.id}/osint/scans`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ kind: 'ip', value: '127.0.0.1', synthesize: false }),
    });
    expect(denied.status).toBe(404);

    const mapped = await fetch(`${url}/api/projects/${project.id}/osint/scans`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ kind: 'ip', value: '::ffff:127.0.0.1', synthesize: false }),
    });
    expect(mapped.status).toBe(404);

    const guessed = await fetch(`${url}/api/osint/rec_guessed`, { headers: { cookie: session.cookie } });
    expect(guessed.status).toBe(404);
    const guessedFindings = await fetch(`${url}/api/osint/rec_guessed/findings`, { headers: { cookie: session.cookie } });
    expect(guessedFindings.status).toBe(404);
  });

  it('refuses conversation OSINT when networkAccess is none', async () => {
    const { url } = await startHost();
    const session = await bootstrap(url);
    const project = (await (
      await fetch(`${url}/api/projects`, { method: 'POST', headers: auth(session), body: JSON.stringify({ name: 'NoNet' }) })
    ).json()) as { id: string };
    const locked = await fetch(`${url}/api/privacy/policy`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ patch: { networkAccess: 'none' }, confirm: 'CONFIRM' }),
    });
    expect(locked.status).toBe(200);
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
      body: JSON.stringify({ content: 'Run OSINT on octocat', capability: 'nexus/fast', tools: true }),
    });
    const text = await assistantText(response);
    expect(text).toMatch(/Permission denied/i);
  });
});
