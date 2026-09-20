import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { Spine } from '../../apps/host/src/index.ts';
import {
  PRODUCTION_ORIGIN,
  assistantText,
  authHeaders,
  nativeLogin,
  octocatInspect,
  startProductionHost,
} from './harness.ts';

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

function originAuth(session: { cookie: string; csrf: string }) {
  return authHeaders(session, { origin: PRODUCTION_ORIGIN });
}

async function ask(
  url: string,
  session: { cookie: string; csrf: string },
  conversationId: string,
  content: string,
): Promise<string> {
  const response = await fetch(`${url}/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: originAuth(session),
    body: JSON.stringify({ content, capability: 'nexus/fast', tools: true }),
  });
  expect(response.ok).toBe(true);
  return assistantText(response);
}

describe('production product acceptance', { timeout: 180_000 }, () => {
  it('native login plus Conversation, Projects/Library, Research, OSINT, Writing, Website, Music', async () => {
    const started = await startProductionHost({
      production: true,
      provisionLogin: true,
      osintInspect: octocatInspect(),
    });
    servers.push(started.server);
    spines.push(started.spine);

    const bootstrap = await fetch(`${started.url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PRODUCTION_ORIGIN },
      body: '{}',
    });
    expect(bootstrap.status).toBe(401);

    const session = await nativeLogin(started.url);
    expect(session.cookie).toMatch(/HttpOnly/i);
    expect(session.cookie).toMatch(/Secure/i);

    const projectRes = await fetch(`${started.url}/api/projects`, {
      method: 'POST',
      headers: originAuth(session),
      body: JSON.stringify({ name: 'Readiness' }),
    });
    expect(projectRes.status).toBe(201);
    const project = (await projectRes.json()) as { id: string };

    const upload = await fetch(`${started.url}/api/projects/${project.id}/files`, {
      method: 'POST',
      headers: originAuth(session),
      body: JSON.stringify({ path: 'brief.md', text: 'harbour notes' }),
    });
    expect(upload.status).toBe(201);

    const conversation = (await (
      await fetch(`${started.url}/api/projects/${project.id}/conversations`, {
        method: 'POST',
        headers: originAuth(session),
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };

    const recalled = await ask(
      started.url,
      session,
      conversation.id,
      "Remember that the harbour code is ORPHEUS-731 and then confirm it.",
    );
    expect(recalled).toMatch(/ORPHEUS-731/);

    const researchChat = (await (
      await fetch(`${started.url}/api/projects/${project.id}/conversations`, {
        method: 'POST',
        headers: originAuth(session),
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };
    const research = await ask(
      started.url,
      session,
      researchChat.id,
      'Research the history of the World Wide Web using multiple independent sources. Tell me what is strongly established.',
    );
    expect(research).toMatch(/Researching:|Sources inspected|Strongest finding/i);
    expect(research).toMatch(/https?:\/\//);

    const osintChat = (await (
      await fetch(`${started.url}/api/projects/${project.id}/conversations`, {
        method: 'POST',
        headers: originAuth(session),
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };
    const osint = await ask(started.url, session, osintChat.id, 'Run OSINT on octocat');
    expect(osint).toMatch(/OSINT username scan of `octocat`/);
    expect(osint).toMatch(/GitHub/);
    expect(osint).toMatch(/Strongest finding:/);

    const writingChat = (await (
      await fetch(`${started.url}/api/projects/${project.id}/conversations`, {
        method: 'POST',
        headers: originAuth(session),
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };
    const writing = await ask(
      started.url,
      session,
      writingChat.id,
      'Write a 500-word scene about a lighthouse keeper hearing a voice from the fog.',
    );
    expect(writing).toMatch(/^Writing:|^Manuscript:/m);
    expect(writing).toMatch(/Revision/);

    const websiteChat = (await (
      await fetch(`${started.url}/api/projects/${project.id}/conversations`, {
        method: 'POST',
        headers: originAuth(session),
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };
    const website = await ask(
      started.url,
      session,
      websiteChat.id,
      'Build a website about a neighbourhood circus with tents, tickets, and cocoa.',
    );
    expect(website).toMatch(/^Website:/);
    const siteId = website.match(/^Site:\s+(site_\S+)/m)?.[1];
    expect(siteId).toBeTruthy();
    const preview = await fetch(`${started.url}/api/sites/${siteId}/preview`, {
      headers: { cookie: session.cookie, origin: PRODUCTION_ORIGIN },
    });
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-security-policy')).toMatch(/sandbox/);

    const musicChat = (await (
      await fetch(`${started.url}/api/projects/${project.id}/conversations`, {
        method: 'POST',
        headers: originAuth(session),
        body: JSON.stringify({}),
      })
    ).json()) as { id: string };
    const music = await ask(
      started.url,
      session,
      musicChat.id,
      'Compose a 30-second piano piece in A minor, 90 BPM.',
    );
    expect(music).toMatch(/^Music:/);
    expect(music).not.toMatch(/runpod|ace-step|provider\//i);
    const compositionId = music.match(/^Composition:\s+(cmp_\S+)/m)?.[1];
    expect(compositionId).toBeTruthy();
    const audition = await fetch(`${started.url}/api/compositions/${compositionId}/audition`, {
      headers: { cookie: session.cookie, origin: PRODUCTION_ORIGIN, range: 'bytes=0-11' },
    });
    expect([200, 206]).toContain(audition.status);
    expect(audition.headers.get('content-type')).toMatch(/audio\/wav/);
    const wavHead = Buffer.from(await audition.arrayBuffer());
    expect(wavHead.subarray(0, 4).toString('ascii')).toBe('RIFF');

    const unauthAudition = await fetch(`${started.url}/api/compositions/${compositionId}/audition`);
    expect([401, 403]).toContain(unauthAudition.status);

    const files = await fetch(`${started.url}/api/projects/${project.id}/files`, {
      headers: { cookie: session.cookie, origin: PRODUCTION_ORIGIN },
    });
    expect(files.status).toBe(200);
    const listed = (await files.json()) as Array<{ path: string }>;
    expect(listed.some((item) => item.path.includes('brief.md'))).toBe(true);

    const guessed = await fetch(`${started.url}/api/projects/prj_guessed_other_tenant`, {
      headers: { cookie: session.cookie, origin: PRODUCTION_ORIGIN },
    });
    expect(guessed.status).toBe(404);
  });
});
