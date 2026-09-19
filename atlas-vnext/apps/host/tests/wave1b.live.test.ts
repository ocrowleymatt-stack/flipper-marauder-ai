import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { PersistenceConfig } from '@atlas-vnext/persistence';
import {
  composeSpine,
  createHost,
  grantSideEffects,
  listen,
  NodeFederatedSearch,
  NodeSourceInspect,
  WikipediaSearchEngine,
  SearxngSearchEngine,
  BraveSearchEngine,
  searchEnginesFromEnv,
  type Spine,
} from '../src/index.ts';

const enabled = process.env.ATLAS_WAVE1B_LIVE === '1';
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

function postgresConfig(tenantId: string): PersistenceConfig | null {
  const url = process.env.ATLAS_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!url) return null;
  return {
    mode: 'postgres',
    production: false,
    databaseUrl: url,
    poolMax: 4,
    idleTimeoutMs: 10_000,
    connectionTimeoutMs: 8_000,
    statementTimeoutMs: 30_000,
    filePath: null,
    defaultTenantId: tenantId,
  };
}

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

async function assistantFromSse(response: Response): Promise<{ text: string; raw: string }> {
  const raw = await response.text();
  const chunks: string[] = [];
  let completed = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = JSON.parse(line.slice(6)) as { type?: string; text?: string };
    if (payload.type === 'assistant.completed' && payload.text) completed = payload.text;
    if (payload.type === 'assistant.delta' && payload.text) chunks.push(payload.text);
  }
  return { text: completed || chunks.join(''), raw };
}

function scoreInspect(url: string): boolean {
  return /wikipedia\.org|w3\.org|cern\.ch|info\.cern/i.test(url);
}

describe.skipIf(!enabled)('Wave 1B live search/inspect/research', { timeout: 180_000 }, () => {
  it('exercises Wikipedia and configured SearXNG, then inspects real pages', async () => {
    const env = {
      SEARXNG_BASE_URL: process.env.SEARXNG_BASE_URL?.trim() || '',
      BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY?.trim() || '',
    };
    const engines = searchEnginesFromEnv(env, 'live');
    expect(engines.map((row) => row.id)).toContain('wikipedia');
    expect(engines.every((row) => row.id !== 'fixture')).toBe(true);

    const wiki = new WikipediaSearchEngine();
    const wikiHits = await wiki.search('history of the World Wide Web', 5);
    expect(wikiHits.length).toBeGreaterThan(0);
    expect(wikiHits.some((hit) => /wikipedia\.org/i.test(hit.url))).toBe(true);
    expect(wikiHits.some((hit) => /world wide web/i.test(`${hit.title} ${hit.snippet}`))).toBe(true);

    const searxUrl = env.SEARXNG_BASE_URL;
    const braveKey = env.BRAVE_SEARCH_API_KEY;
    const report = {
      brave: { configured: Boolean(braveKey), exercised: false, success: false, hits: 0 },
      searxng: { configured: Boolean(searxUrl), exercised: false, success: false, hits: 0 },
      wikipedia: { configured: true, exercised: true, success: wikiHits.length > 0, hits: wikiHits.length },
    };

    if (searxUrl) {
      report.searxng.exercised = true;
      const searx = new SearxngSearchEngine(searxUrl, undefined);
      const hits = await searx.search('Tim Berners-Lee CERN World Wide Web', 8);
      report.searxng.hits = hits.length;
      report.searxng.success =
        hits.length > 0 &&
        hits.some((hit) =>
          /cern|w3\.org|berners|world wide web|info\.cern/i.test(`${hit.title} ${hit.url} ${hit.snippet}`),
        );
      // eslint-disable-next-line no-console
      console.log(
        'WAVE1B_SEARXNG_HITS',
        JSON.stringify(hits.slice(0, 5).map((hit) => ({ url: hit.url, title: hit.title }))),
      );
    }
    if (braveKey) {
      report.brave.exercised = true;
      const brave = new BraveSearchEngine(braveKey);
      const hits = await brave.search('history of the World Wide Web', 5);
      report.brave.hits = hits.length;
      report.brave.success = hits.length > 0;
      expect(report.brave.success).toBe(true);
    }

    const federated = new NodeFederatedSearch(engines);
    const fused = await federated.search({ query: 'history of the World Wide Web Tim Berners-Lee', count: 8 });
    expect(fused.engines).toContain('wikipedia');
    expect(fused.hits.length).toBeGreaterThan(1);
    expect(fused.hits.every((hit) => hit.engine !== 'fixture')).toBe(true);

    const inspect = new NodeSourceInspect();
    const preferred = [...wikiHits.map((hit) => hit.url), ...fused.hits.map((hit) => hit.url)].filter(
      (url, index, all) => all.indexOf(url) === index,
    );
    preferred.sort((a, b) => Number(scoreInspect(b)) - Number(scoreInspect(a)));
    const inspected: Array<{ url: string; status: number; contentType: string; hash: string; truncated: boolean }> = [];
    const inspectErrors: Array<{ url: string; error: string }> = [];
    for (const url of preferred) {
      if (inspected.length >= 3) break;
      try {
        const page = await inspect.inspect({ url });
        if (!page.ok || page.text.length <= 40) {
          inspectErrors.push({ url, error: `status ${page.status}` });
          continue;
        }
        expect(page.contentHash).toMatch(/^[a-f0-9]{64}$/);
        inspected.push({
          url: page.finalUrl,
          status: page.status,
          contentType: page.contentType,
          hash: page.contentHash,
          truncated: page.truncated,
        });
      } catch (err) {
        inspectErrors.push({ url, error: err instanceof Error ? err.message : String(err) });
      }
    }
    expect(inspected.length).toBeGreaterThan(0);
    expect(inspected.some((row) => /wikipedia\.org|cern\.ch|w3\.org/i.test(row.url))).toBe(true);
    // eslint-disable-next-line no-console
    console.log('WAVE1B_ENGINES', JSON.stringify({ report, inspected, inspectErrors }));
    expect(report.wikipedia.success).toBe(true);
    if (report.searxng.configured) expect(report.searxng.success).toBe(true);
  });

  it('runs live deep research into the requesting Atlas conversation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-wave1b-'));
    const persistence = postgresConfig('tenant_a') ?? memoryConfig('tenant_a');
    const spine = await composeSpine({
      dataPath: join(dir, 'state.json'),
      mode: 'mock',
      searchMode: 'live',
      persistence,
      casRoot: join(dir, 'cas'),
      env: {
        SEARXNG_BASE_URL: process.env.SEARXNG_BASE_URL?.trim() || '',
        BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY?.trim() || '',
        ATLAS_TENANT_ID: 'tenant_a',
      },
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
      research: spine.research,
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
    const boot = await fetch(`${bound.url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const session = { cookie: boot.headers.get('set-cookie') ?? '', csrf: ((await boot.json()) as { csrfToken: string }).csrfToken };
    const headers = { cookie: session.cookie, 'x-atlas-csrf': session.csrf, 'content-type': 'application/json' };
    const project = (await (await fetch(`${bound.url}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ name: 'Wave1B' }) })).json()) as { id: string };
    const conversation = (await (
      await fetch(`${bound.url}/api/projects/${project.id}/conversations`, { method: 'POST', headers, body: '{}' })
    ).json()) as { id: string };

    const send = async (content: string) => {
      const response = await fetch(`${bound.url}/api/conversations/${conversation.id}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content, capability: 'nexus/fast', tools: true }),
      });
      expect(response.ok).toBe(true);
      return assistantFromSse(response);
    };

    await send("My dog's name is ORPHEUS-731.");
    const recalled = await send("What did I say my dog's name was?");
    expect(recalled.text).toContain('ORPHEUS-731');

    const research = await send(
      'Research the early history of the World Wide Web using multiple independent sources. Identify the strongest established facts, any material disagreement between sources, and remaining uncertainty.',
    );
    expect(research.text).toMatch(/Researching:/i);
    expect(research.text).toMatch(/Sources inspected/i);
    expect(research.text).toMatch(/https?:\/\//);
    expect(research.text).not.toMatch(/FixtureSearchEngine|encyclopedic overview used as an independent source/i);
    expect(research.raw).toMatch(/assistant\.completed/);

    const strongest = await send('Which of those findings has the strongest evidence?');
    expect(strongest.text.toLowerCase()).toMatch(/strongest/);

    const records = await spine.persistence
      ?.forActor({ tenantId: spine.tenantId, principalId: spine.principalId })
      .dungeonRecords.list(
        { tenantId: spine.tenantId, principalId: spine.principalId },
        { workspaceId: project.id, dungeon: 'research', kind: 'synthesis' },
      );
    expect(records?.[0]?.conversationId).toBe(conversation.id);
    expect(records?.[0]?.status).toBe('completed');
    const findings = records?.[0]?.payload?.findings as Array<{ url?: string; engine?: string }> | undefined;
    expect(Array.isArray(findings) && findings.length > 0).toBe(true);
    expect(findings?.every((row) => row.engine !== 'fixture')).toBe(true);
  });

  it('reopens the same PostgreSQL conversation after process restart', async () => {
    const persistence = postgresConfig('tenant_wave1b_restart');
    if (!persistence) return;
    const dir = mkdtempSync(join(tmpdir(), 'atlas-wave1b-pg-'));
    const boot = async () => {
      const spine = await composeSpine({
        dataPath: join(dir, 'state.json'),
        mode: 'mock',
        searchMode: 'live',
        persistence,
        casRoot: join(dir, 'cas'),
        env: {
          SEARXNG_BASE_URL: process.env.SEARXNG_BASE_URL?.trim() || '',
          ATLAS_TENANT_ID: 'tenant_wave1b_restart',
        },
        streamDelayMs: 0,
      });
      grantSideEffects(spine.authority, spine.principalId, spine.tenantId);
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
        research: spine.research,
        privacy: spine.privacy,
        tenantId: spine.tenantId,
        principalId: spine.principalId,
        flags: spine.flags,
        killSwitches: spine.killSwitches,
        resources: spine.resources,
        maxRequestBytes: spine.limits.maxRequestBytes,
        maxUploadBytes: spine.limits.maxUploadBytes,
      });
      const bound = await listen(server, 0, '127.0.0.1');
      return { spine, server, url: bound.url };
    };

    const first = await boot();
    spines.push(first.spine);
    servers.push(first.server);
    const session1 = await (async () => {
      const response = await fetch(`${first.url}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return { cookie: response.headers.get('set-cookie') ?? '', csrf: ((await response.json()) as { csrfToken: string }).csrfToken };
    })();
    const headers1 = { cookie: session1.cookie, 'x-atlas-csrf': session1.csrf, 'content-type': 'application/json' };
    const project = (await (await fetch(`${first.url}/api/projects`, { method: 'POST', headers: headers1, body: JSON.stringify({ name: 'Restart' }) })).json()) as { id: string };
    const conversation = (await (
      await fetch(`${first.url}/api/projects/${project.id}/conversations`, { method: 'POST', headers: headers1, body: '{}' })
    ).json()) as { id: string };
    const send1 = async (content: string) => {
      const response = await fetch(`${first.url}/api/conversations/${conversation.id}/messages`, {
        method: 'POST',
        headers: headers1,
        body: JSON.stringify({ content, capability: 'nexus/fast', tools: true }),
      });
      expect(response.ok).toBe(true);
      return assistantFromSse(response);
    };
    await send1("My dog's name is ORPHEUS-731.");
    await send1(
      'Research the early history of the World Wide Web using multiple independent sources. Identify the strongest established facts.',
    );

    await new Promise<void>((resolve, reject) => first.server.close((err) => (err ? reject(err) : resolve())));
    servers.pop();
    await first.spine.close();
    spines.pop();

    const second = await boot();
    spines.push(second.spine);
    servers.push(second.server);
    const session2res = await fetch(`${second.url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const session2 = {
      cookie: session2res.headers.get('set-cookie') ?? '',
      csrf: ((await session2res.json()) as { csrfToken: string }).csrfToken,
    };
    const restored = await fetch(`${second.url}/api/conversations/${conversation.id}`, { headers: { cookie: session2.cookie } });
    expect(restored.status).toBe(200);
    const body = (await restored.json()) as { messages: Array<{ content: string }> };
    expect(body.messages.some((row) => row.content.includes('ORPHEUS-731'))).toBe(true);
    expect(body.messages.some((row) => /World Wide Web/i.test(row.content))).toBe(true);

    const researching = await fetch(`${second.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { cookie: session2.cookie, 'x-atlas-csrf': session2.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'What were we researching?',
        capability: 'nexus/fast',
        tools: true,
      }),
    });
    const topic = await assistantFromSse(researching);
    expect(topic.text.toLowerCase()).toMatch(/world wide web/);

    const dog = await fetch(`${second.url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { cookie: session2.cookie, 'x-atlas-csrf': session2.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({
        content: "What did I say my dog's name was?",
        capability: 'nexus/fast',
        tools: true,
      }),
    });
    const recalled = await assistantFromSse(dog);
    if (!recalled.text.includes('ORPHEUS-731')) {
      // eslint-disable-next-line no-console
      console.warn('WAVE1B_HISTORY_OVERFLOW', {
        messageChars: body.messages.reduce((sum, row) => sum + row.content.length, 0),
        recalled: recalled.text.slice(0, 240),
      });
    }
    expect(recalled.text).toContain('ORPHEUS-731');
  });
});
