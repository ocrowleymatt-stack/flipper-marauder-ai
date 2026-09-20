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
  const dir = mkdtempSync(join(tmpdir(), 'atlas-wave6-'));
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

async function ask(url: string, session: { cookie: string; csrf: string }, conversationId: string, content: string) {
  return assistantText(
    await fetch(`${url}/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ content, capability: 'nexus/fast' }),
    }),
  );
}

describe('Wave 6 Music recovery', () => {
  it('composes from chat, streams playable WAV, and revises the same composition', async () => {
    const { url, spine } = await startHost();
    const session = await bootstrap(url);
    const project = (await (
      await fetch(`${url}/api/projects`, { method: 'POST', headers: auth(session), body: JSON.stringify({ name: 'Wave6' }) })
    ).json()) as { id: string };
    const conversation = (await (
      await fetch(`${url}/api/projects/${project.id}/conversations`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };

    const reply = await ask(url, session, conversation.id, 'Compose a 30-second piano piece in A minor, 90 BPM.');
    expect(reply).toMatch(/^Music:/);
    expect(reply).toMatch(/playable/i);
    expect(reply).not.toMatch(/runpod|ace-step|provider\//i);
    const compositionId = reply.match(/^Composition:\s+(cmp_\S+)/m)?.[1];
    expect(compositionId).toBeTruthy();
    const tempo = Number(reply.match(/^Tempo:\s+(\d+)/m)?.[1]);
    expect(tempo).toBe(90);

    const snapshot = (await (await fetch(`${url}/api/conversations/${conversation.id}`, { headers: { cookie: session.cookie } })).json()) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(snapshot.messages.some((message) => message.role === 'assistant' && message.content.includes(compositionId!))).toBe(true);

    const audition = await fetch(`${url}/api/compositions/${compositionId}/audition`, { headers: { cookie: session.cookie } });
    expect(audition.status).toBe(200);
    expect(audition.headers.get('content-type')).toMatch(/audio\/wav/);
    expect(audition.headers.get('accept-ranges')).toMatch(/bytes/i);
    expect(audition.headers.get('x-content-type-options')).toBe('nosniff');
    expect(audition.headers.get('cache-control')).toMatch(/private/);
    const wav = Buffer.from(await audition.arrayBuffer());
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');

    const ranged = await fetch(`${url}/api/compositions/${compositionId}/audition`, {
      headers: { cookie: session.cookie, range: 'bytes=0-11' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toMatch(/^bytes 0-11\//);
    const rangeBody = Buffer.from(await ranged.arrayBuffer());
    expect(rangeBody.byteLength).toBe(12);
    expect(rangeBody.subarray(0, 4).toString('ascii')).toBe('RIFF');

    const midi = await fetch(`${url}/api/compositions/${compositionId}/midi`, { headers: { cookie: session.cookie } });
    expect(midi.status).toBe(200);
    expect(Buffer.from(await midi.arrayBuffer()).subarray(0, 4).toString('ascii')).toBe('MThd');

    const files = (await (await fetch(`${url}/api/projects/${project.id}/files`, { headers: { cookie: session.cookie } })).json()) as Array<{
      path: string;
      origin?: string;
      id: string;
    }>;
    const wavFile = files.find((file) => file.path === `compositions/${compositionId}/audition.wav`);
    expect(wavFile).toBeTruthy();
    expect(wavFile?.origin).toBe('generated');
    const fileStream = await fetch(`${url}/api/files/${wavFile!.id}/content`, { headers: { cookie: session.cookie } });
    expect(fileStream.status).toBe(200);
    expect(fileStream.headers.get('content-type')).toMatch(/audio\/wav/);

    const slower = await ask(url, session, conversation.id, 'Make it slower.');
    expect(slower).toMatch(/Revision: 2/);
    expect(slower).toContain(compositionId);
    expect(Number(slower.match(/^Tempo:\s+(\d+)/m)?.[1])).toBeLessThan(tempo);

    const unauth = await fetch(`${url}/api/compositions/${compositionId}/audition`);
    expect([401, 403]).toContain(unauth.status);
    const unauthRange = await fetch(`${url}/api/compositions/${compositionId}/audition`, { headers: { range: 'bytes=0-11' } });
    expect([401, 403]).toContain(unauthRange.status);
    const unauthFile = await fetch(`${url}/api/files/${wavFile!.id}/content`, { headers: { range: 'bytes=0-11' } });
    expect([401, 403]).toContain(unauthFile.status);

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
    };
    const foreign = await fetch(`${url}/api/compositions/${compositionId}`, { headers: headersB });
    expect(foreign.status).toBe(404);
    const foreignRange = await fetch(`${url}/api/compositions/${compositionId}/audition`, {
      headers: { ...headersB, range: 'bytes=0-11' },
    });
    expect(foreignRange.status).toBe(404);
    expect(foreignRange.headers.get('content-type')).not.toMatch(/audio\/wav/);
    const foreignFileRange = await fetch(`${url}/api/files/${wavFile!.id}/content`, {
      headers: { ...headersB, range: 'bytes=0-11' },
    });
    expect([403, 404]).toContain(foreignFileRange.status);
  });

  it('does not steal writing, website, research, or OSINT, and binds regenerate to the conversation', async () => {
    const { url } = await startHost();
    const session = await bootstrap(url);
    const project = (await (
      await fetch(`${url}/api/projects`, { method: 'POST', headers: auth(session), body: JSON.stringify({ name: 'Wave6R' }) })
    ).json()) as { id: string };
    const conversation = (await (
      await fetch(`${url}/api/projects/${project.id}/conversations`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };

    expect(await ask(url, session, conversation.id, 'Write a 500-word scene about a lighthouse keeper hearing a voice from the fog.')).toMatch(/^Writing:/);
    expect(await ask(url, session, conversation.id, 'Build a website about jazz')).toMatch(/^Website:/);
    expect(
      await assistantText(
        await fetch(`${url}/api/conversations/${conversation.id}/messages`, {
          method: 'POST',
          headers: auth(session),
          body: JSON.stringify({
            content: 'Research the history of jazz using multiple independent sources.',
            capability: 'nexus/fast',
            tools: true,
          }),
        }),
      ),
    ).toMatch(/Researching:/i);
    expect(
      await assistantText(
        await fetch(`${url}/api/conversations/${conversation.id}/messages`, {
          method: 'POST',
          headers: auth(session),
          body: JSON.stringify({
            content: 'OSINT on octocat',
            capability: 'nexus/fast',
            tools: true,
          }),
        }),
      ),
    ).toMatch(/^OSINT/i);
    expect(await ask(url, session, conversation.id, 'Write a song about rain')).toMatch(/^Music:/);

    const firstConversation = (await (
      await fetch(`${url}/api/projects/${project.id}/conversations`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };
    const first = await ask(url, session, firstConversation.id, 'Compose a 30-second piano piece in A minor, 90 BPM.');
    const firstId = first.match(/^Composition:\s+(cmp_\S+)/m)?.[1];
    const secondConversation = (await (
      await fetch(`${url}/api/projects/${project.id}/conversations`, {
        method: 'POST',
        headers: auth(session),
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };
    const second = await ask(url, session, secondConversation.id, 'Write a song about rain');
    const secondId = second.match(/^Composition:\s+(cmp_\S+)/m)?.[1];
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
    const regenerated = await ask(url, session, firstConversation.id, 'Regenerate this version.');
    expect(regenerated).toContain(firstId);
    expect(regenerated).not.toContain(secondId);

    const unauthCompose = await fetch(`${url}/api/compositions/${firstId}/compose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief: 'steal' }),
    });
    expect([401, 403]).toContain(unauthCompose.status);
  });
});
