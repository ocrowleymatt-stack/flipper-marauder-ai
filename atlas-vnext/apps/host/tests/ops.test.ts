import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { composeSpine, createHost, listen } from '../src/index.ts';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
});

describe('host health and security', () => {
  it('liveness is independent of optional providers; readiness reflects critical deps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-host-'));
    const spine = await composeSpine({ dataPath: join(dir, 'state.json'), mode: 'mock' });
    const server = createHost({
      runtime: spine.runtime,
      health: { mode: spine.mode, providers: spine.health },
      probe: spine.healthProbe,
      shutdown: spine.shutdown,
    });
    servers.push(server);
    const bound = await listen(server, 0, '127.0.0.1');
    const live = await fetch(`${bound.url}/api/health/live`);
    expect(live.status).toBe(200);
    const ready = await fetch(`${bound.url}/api/health/ready`);
    expect(ready.status).toBe(200);
    const health = (await (await fetch(`${bound.url}/api/health`)).json()) as {
      ok: boolean;
      ready: boolean;
      dependencies: { postgres: string };
      identity?: { sourceSha: string; profile: string };
    };
    expect(health.ok).toBe(true);
    expect(health.ready).toBe(true);
    expect(health.dependencies.postgres).toBe('not_configured');
    expect(typeof health.identity?.sourceSha).toBe('string');
    expect(typeof health.identity?.profile).toBe('string');
    spine.shutdown.begin();
    const stopped = await fetch(`${bound.url}/api/health/ready`);
    expect(stopped.status).toBe(503);
  });

  it('requires CSRF for mutating cookie requests and binds tool routes to the session principal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-host-'));
    const spine = await composeSpine({ dataPath: join(dir, 'state.json'), mode: 'mock' });
    const server = createHost({
      runtime: spine.runtime,
      auth: spine.auth,
      tools: spine.tools,
      tenantId: spine.tenantId,
      principalId: spine.principalId,
    });
    servers.push(server);
    const bound = await listen(server, 0, '127.0.0.1');
    const issued = await spine.auth.issueSession({
      principalId: spine.principalId,
      tenantId: spine.tenantId,
    });
    const forged = await fetch(`${bound.url}/api/tools/tinv_guess/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: spine.auth.cookieHeader(issued.session.id),
      },
      body: '{}',
    });
    expect(forged.status).toBe(403);
    const missing = await fetch(`${bound.url}/api/tools/tinv_guess`, {
      headers: { cookie: spine.auth.cookieHeader(issued.session.id) },
    });
    expect(missing.status).toBe(404);
    const body = (await missing.json()) as { error: string };
    expect(body.error).toBe('Permission denied.');
  });

  it('exposes System Doctor only to the session principal and never auto-applies consequential repairs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-host-'));
    const spine = await composeSpine({ dataPath: join(dir, 'state.json'), mode: 'mock' });
    const server = createHost({
      runtime: spine.runtime,
      auth: spine.auth,
      doctor: spine.doctor,
      repairs: spine.repairs,
      tenantId: spine.tenantId,
      principalId: spine.principalId,
    });
    servers.push(server);
    const bound = await listen(server, 0, '127.0.0.1');
    const anon = await fetch(`${bound.url}/api/ops/doctor`);
    expect(anon.status).toBe(401);
    const issued = await spine.auth.issueSession({
      principalId: spine.principalId,
      tenantId: spine.tenantId,
    });
    const headers = {
      cookie: spine.auth.cookieHeader(issued.session.id),
      'x-atlas-csrf': issued.csrfToken,
    };
    const doctor = await fetch(`${bound.url}/api/ops/doctor`, { headers });
    expect(doctor.status).toBe(200);
    const report = (await doctor.json()) as { state: string; checks: Array<{ id: string }> };
    expect(typeof report.state).toBe('string');
    expect(report.checks.some((check) => check.id === 'architecture')).toBe(true);
    const apply = await fetch(`${bound.url}/api/ops/repairs/repair.migrate_schema/apply`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(apply.status).toBe(200);
    const execution = (await apply.json()) as { status: string; authorityDecision: string };
    expect(execution.status === 'denied' || execution.status === 'proposed').toBe(true);
    expect(execution.status).not.toBe('applied');
    const unknown = await fetch(`${bound.url}/api/ops/repairs/not-a-repair/apply`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(unknown.status).toBe(404);
  });

  it('honours ATLAS_SESSION_COOKIE so staging cannot collide with original Atlas cookies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-host-cookie-'));
    const spine = await composeSpine({
      dataPath: join(dir, 'state.json'),
      mode: 'mock',
      env: { ATLAS_SESSION_COOKIE: 'atlas_vnext_staging_session' },
    });
    expect(spine.auth.cookieName).toBe('atlas_vnext_staging_session');
    expect(spine.auth.cookieHeader('sess_test').startsWith('atlas_vnext_staging_session=')).toBe(true);
  });
});
