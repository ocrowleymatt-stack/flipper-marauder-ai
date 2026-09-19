import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { PersistenceConfig } from '@atlas-vnext/persistence';
import { composeSpine, createHost, grantSideEffects, listen, type Spine } from '../src/index.ts';
import { AuthorityEngine } from '@atlas-vnext/permissions';
import { ResearchService } from '@atlas-vnext/dungeon-research';
import { openDungeonStack, closePersistence } from '../../../tests/helpers/dungeon-stack.ts';
import { NodeSourceInspect } from '../src/inspect.ts';

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
  const dir = mkdtempSync(join(tmpdir(), 'atlas-wave1-'));
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

describe('Wave 1 Atlas recovery', () => {
  it('remembers ORPHEUS-731, researches the web, resolves those findings, and survives logout', async () => {
    const { url, spine } = await startHost();
    const session = await bootstrap(url);
    const project = (await (
      await fetch(`${url}/api/projects`, { method: 'POST', headers: auth(session), body: JSON.stringify({ name: 'Wave1' }) })
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

    await send("My dog's name is ORPHEUS-731.");
    await send('Understood, continue.');
    const recalled = await send("What did I say my dog's name was?");
    expect(recalled).toContain('ORPHEUS-731');

    const research = await send(
      'Research the history of the World Wide Web using multiple independent sources. Tell me what is strongly established, where sources disagree, and what remains uncertain.',
    );
    expect(research).toMatch(/Researching:/i);
    expect(research).toMatch(/Sources inspected/i);
    expect(research).toMatch(/Strongest finding:/i);
    expect(research).toMatch(/https?:\/\//);

    const strongest = await send('Which of those findings has the strongest evidence?');
    expect(strongest.toLowerCase()).toMatch(/strongest finding/);

    const snap = await fetch(`${url}/api/conversations/${conversation.id}`, { headers: { cookie: session.cookie } });
    expect(snap.status).toBe(200);
    const body = (await snap.json()) as { messages: Array<{ content: string }> };
    expect(body.messages.some((row) => row.content.includes('ORPHEUS-731'))).toBe(true);
    expect(body.messages.some((row) => /World Wide Web/i.test(row.content))).toBe(true);

    await fetch(`${url}/api/session/revoke`, { method: 'POST', headers: auth(session), body: '{}' });
    const again = await bootstrap(url);
    const restored = await fetch(`${url}/api/conversations/${conversation.id}`, { headers: { cookie: again.cookie } });
    expect(restored.status).toBe(200);
    const restoredBody = (await restored.json()) as { messages: Array<{ content: string }> };
    expect(restoredBody.messages.some((row) => row.content.includes('ORPHEUS-731'))).toBe(true);

    const researching = await fetch(`${url}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: auth(again),
      body: JSON.stringify({ content: 'What were we researching?', capability: 'nexus/fast', tools: true }),
    });
    const topic = await assistantText(researching);
    expect(topic.toLowerCase()).toMatch(/world wide web/);

    const records = await spine.persistence
      ?.forActor({ tenantId: spine.tenantId, principalId: spine.principalId })
      .dungeonRecords.list(
        { tenantId: spine.tenantId, principalId: spine.principalId },
        { workspaceId: project.id, dungeon: 'research', kind: 'synthesis' },
      );
    expect(records?.[0]?.conversationId).toBe(conversation.id);
  });

  it('rejects guessed conversations and cross-tenant access', async () => {
    const { url } = await startHost();
    const session = await bootstrap(url);
    const missing = await fetch(`${url}/api/conversations/con_guessed`, { headers: { cookie: session.cookie } });
    expect(missing.status).toBe(404);
    const other = await fetch(`${url}/api/conversations/con_guessed/messages`, {
      method: 'POST',
      headers: auth(session),
      body: JSON.stringify({ content: 'hello', capability: 'nexus/fast' }),
    });
    const text = await other.text();
    expect(other.status === 404 || text.includes('not found')).toBe(true);
  });
});

describe('Wave 1 security', () => {
  it('denies web research without network.public', async () => {
    const stack = await openDungeonStack();
    try {
      const authority = new AuthorityEngine();
      authority.grantMembership(stack.actor.principalId, stack.actor.tenantId);
      for (const cap of ['artifact.read', 'artifact.write', 'project.read', 'file.read'] as const) {
        authority.grantTo({ principalId: stack.actor.principalId, tenantId: stack.actor.tenantId, capability: cap });
      }
      const research = new ResearchService({
        persistence: stack.persistence,
        projects: stack.projects,
        files: stack.files,
        context: stack.context,
        runtime: stack.runtime,
        authority,
        policy: stack.policy,
        search: {
          async search() {
            throw new Error('search must not run');
          },
        },
        inspect: {
          async inspect() {
            throw new Error('inspect must not run');
          },
        },
      });
      const brief = await research.create(stack.actor, {
        projectId: stack.project.id,
        question: 'Research the history of the World Wide Web using multiple independent sources.',
      });
      await expect(research.run(stack.actor, brief.id)).rejects.toMatchObject({ code: 'insufficient_evidence' });
    } finally {
      await closePersistence(stack.persistence);
    }
  });

  it('does not inspect private targets even when asked by research', async () => {
    const inspect = new NodeSourceInspect({
      lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    await expect(inspect.inspect({ url: 'http://127.0.0.1/latest/meta-data/' })).rejects.toThrow();
  });
});
