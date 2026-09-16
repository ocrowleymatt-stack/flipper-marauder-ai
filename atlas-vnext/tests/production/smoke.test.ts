import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { Spine } from '../../apps/host/src/index.ts';
import { authHeaders, bootstrap, startProductionHost } from './harness.ts';

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

describe('production smoke sequence 1-17', () => {
  it('covers the cutover smoke path against the mock host', async () => {
    const started = await startProductionHost();
    servers.push(started.server);
    spines.push(started.spine);
    const results: string[] = [];

    const live = await fetch(`${started.url}/api/health/live`);
    expect(live.status).toBe(200);
    results.push('1-live');
    const ready = await fetch(`${started.url}/api/health/ready`);
    expect(ready.status).toBe(200);
    results.push('2-ready');

    const session = await bootstrap(started.url);
    expect(session.cookie).toMatch(/HttpOnly/i);
    expect(session.cookie).toMatch(/SameSite=Lax/i);
    results.push('3-auth-cookie');

    const csrf = await fetch(`${started.url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookie },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(csrf.status).toBe(403);
    results.push('4-csrf');

    const projectRes = await fetch(`${started.url}/api/projects`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ name: 'Smoke' }),
    });
    expect(projectRes.status).toBe(201);
    const project = (await projectRes.json()) as { id: string };
    results.push('5-project');

    const upload = await fetch(`${started.url}/api/projects/${project.id}/files`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ path: 'brief.md', text: 'source note' }),
    });
    expect(upload.status).toBe(201);
    const file = (await upload.json()) as { id: string; contentHash: string };
    expect(file.contentHash).toHaveLength(64);
    results.push('6-cas-upload');

    const inspect = await started.spine.files!.inspectCas(
      { tenantId: started.spine.tenantId, principalId: started.spine.principalId },
      file.id,
    );
    expect(inspect.object).toBe('ok');
    results.push('7-cas-present');

    const conversationRes = await fetch(`${started.url}/api/conversations`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ projectId: project.id }),
    });
    expect(conversationRes.status).toBe(201);
    results.push('8-conversation');

    const guessed = await fetch(`${started.url}/api/projects/prj_guessed_other_tenant`, {
      headers: authHeaders(session),
    });
    expect(guessed.status).toBe(404);
    const guessedBody = (await guessed.json()) as { error: string };
    expect(guessedBody.error).not.toMatch(/tenant_b/i);
    results.push('9-tenant-guess');

    const approvals = await fetch(`${started.url}/api/approvals`, { headers: authHeaders(session) });
    expect(approvals.status).toBe(200);
    results.push('10-approvals-list');

    const docRes = await fetch(`${started.url}/api/projects/${project.id}/documents`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ title: 'Smoke chapter' }),
    });
    expect(docRes.status).toBe(201);
    const document = (await docRes.json()) as { id: string; revision: number };
    results.push('11-caspa-create');

    const stale = await fetch(`${started.url}/api/documents/${document.id}`, {
      method: 'PATCH',
      headers: authHeaders(session),
      body: JSON.stringify({ title: 'stale', expectedRevision: 0 }),
    });
    expect(stale.status).toBe(409);
    results.push('12-caspa-stale');

    const logout = await fetch(`${started.url}/api/session/revoke`, {
      method: 'POST',
      headers: authHeaders(session),
      body: '{}',
    });
    expect(logout.status).toBe(200);
    const after = await fetch(`${started.url}/api/projects`, { headers: authHeaders(session) });
    expect([401, 403]).toContain(after.status);
    results.push('13-logout');

    started.spine.shutdown.begin();
    const stopped = await fetch(`${started.url}/api/health/ready`);
    expect(stopped.status).toBe(503);
    results.push('14-shutdown-not-ready');

    const oversized = await fetch(`${started.url}/api/health/live`);
    expect(oversized.status).toBe(200);
    results.push('15-live-after-drain');

    expect(started.spine.timeouts.providerMs).toBeGreaterThan(0);
    results.push('16-timeouts');
    expect(started.spine.killSwitches.tools).toBe(true);
    results.push('17-kill-switches-default-on');

    expect(results).toHaveLength(17);
  });
});
