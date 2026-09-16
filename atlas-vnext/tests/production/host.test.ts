import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { Spine } from '../../apps/host/src/index.ts';
import { authHeaders, bootstrap, readSse, startProductionHost } from './harness.ts';

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

describe('production host security, health, and limits', () => {
  it('separates liveness from readiness, omits secrets, and emits security headers', async () => {
    const started = await startProductionHost({ allowedOrigins: ['http://127.0.0.1:9'] });
    servers.push(started.server);
    spines.push(started.spine);
    const live = await fetch(`${started.url}/api/health/live`);
    expect(live.status).toBe(200);
    const liveBody = (await live.json()) as Record<string, unknown>;
    expect(liveBody.live).toBe(true);
    expect(JSON.stringify(liveBody)).not.toMatch(/postgres:\/\//);
    expect(JSON.stringify(liveBody)).not.toMatch(/secret/i);
    const ready = await fetch(`${started.url}/api/health/ready`);
    expect(ready.status).toBe(200);
    expect(live.headers.get('x-content-type-options')).toBe('nosniff');
    expect(live.headers.get('x-frame-options')).toBe('DENY');
    expect(live.headers.get('referrer-policy')).toBe('no-referrer');
    expect(live.headers.get('permissions-policy')).toMatch(/camera=\(\)/);
    expect(live.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/);
    expect(live.headers.get('strict-transport-security')).toBeNull();
    const metrics = await fetch(`${started.url}/api/metrics`);
    expect(metrics.status).toBe(200);
    const snapshot = (await metrics.json()) as { counters: Record<string, number> };
    expect(JSON.stringify(snapshot)).not.toMatch(/tenant_a|ses_/);
    const health = (await (await fetch(`${started.url}/api/health`)).json()) as {
      ha: boolean;
      topology: string;
      rateLimiterScope: string;
      tracingExporter: string;
    };
    expect(health.ha).toBe(false);
    expect(health.topology).toBe('single-instance');
    expect(health.rateLimiterScope).toBe('in-process');
    expect(health.tracingExporter).toBe('none');
  });

  it('treats a dead database as not ready', async () => {
    const started = await startProductionHost();
    servers.push(started.server);
    spines.push(started.spine);
    started.spine.healthProbe.dependencies = async () => ({
      postgres: 'error',
      cas: 'ok',
      jobs: 'ok',
      runtimeScheduler: 'not_configured',
    });
    const ready = await fetch(`${started.url}/api/health/ready`);
    expect(ready.status).toBe(503);
    const body = (await ready.json()) as { ready: boolean; dependencies: { postgres: string } };
    expect(body.ready).toBe(false);
    expect(body.dependencies.postgres).toBe('error');
    const health = await fetch(`${started.url}/api/health`);
    expect(health.status).toBe(503);
  });

  it('does not combine wildcard CORS with credentials', async () => {
    const started = await startProductionHost({
      production: true,
      allowedOrigins: ['https://atlas.example'],
    });
    servers.push(started.server);
    spines.push(started.spine);
    const allowed = await fetch(`${started.url}/api/health/live`, { headers: { origin: 'https://atlas.example' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://atlas.example');
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
    const denied = await fetch(`${started.url}/api/health/live`, { headers: { origin: 'https://evil.example' } });
    expect(denied.headers.get('access-control-allow-origin') ?? '').not.toBe('*');
    expect(denied.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
  });

  it('rejects oversized bodies and honours generation kill switch', async () => {
    const started = await startProductionHost({ env: { ATLAS_FLAG_GENERATION: 'off' } });
    servers.push(started.server);
    spines.push(started.spine);
    const session = await bootstrap(started.url);
    const conversation = await fetch(`${started.url}/api/conversations`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({}),
    });
    expect(conversation.status).toBe(201);
    const created = (await conversation.json()) as { id: string };
    const blocked = await fetch(`${started.url}/api/conversations/${created.id}/messages`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ content: 'hello' }),
    });
    expect(blocked.status).toBe(503);
    const payload = (await blocked.json()) as { code: string };
    expect(payload.code).toBe('kill_switch');
  });

  it('streams a mock run for smoke and records correlation without prompts', async () => {
    const started = await startProductionHost();
    servers.push(started.server);
    spines.push(started.spine);
    const session = await bootstrap(started.url);
    const conversation = await fetch(`${started.url}/api/conversations`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({}),
    });
    const created = (await conversation.json()) as { id: string };
    const stream = await fetch(`${started.url}/api/conversations/${created.id}/messages`, {
      method: 'POST',
      headers: authHeaders(session, { 'x-request-id': 'req_smoke_correlation_01' }),
      body: JSON.stringify({ content: 'hello atlas', capability: 'nexus/fast' }),
    });
    expect(stream.headers.get('content-type')).toMatch(/text\/event-stream/);
    const frames = await readSse(stream);
    expect(frames.some((frame) => frame.event === 'done')).toBe(true);
  });

  it('applies a lowered ATLAS_MAX_REQUEST_BYTES ceiling to JSON bodies', async () => {
    const started = await startProductionHost({ env: { ATLAS_MAX_REQUEST_BYTES: '48' } });
    servers.push(started.server);
    spines.push(started.spine);
    expect(started.spine.limits.maxRequestBytes).toBe(48);
    const session = await bootstrap(started.url);
    const oversized = await fetch(`${started.url}/api/conversations`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ title: 'x'.repeat(80) }),
    });
    expect(oversized.status).toBe(413);
    const body = (await oversized.json()) as { code: string };
    expect(body.code).toBe('payload_too_large');
    const ok = await fetch(`${started.url}/api/conversations`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ title: 'ok' }),
    });
    expect(ok.status).toBe(201);
  });

  it('applies a lowered ATLAS_MAX_UPLOAD_BYTES ceiling to file uploads', async () => {
    const started = await startProductionHost({ env: { ATLAS_MAX_UPLOAD_BYTES: '64' } });
    servers.push(started.server);
    spines.push(started.spine);
    expect(started.spine.limits.maxUploadBytes).toBe(64);
    const session = await bootstrap(started.url);
    const projectRes = await fetch(`${started.url}/api/projects`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ name: 'Bytes' }),
    });
    expect(projectRes.status).toBe(201);
    const project = (await projectRes.json()) as { id: string };
    const oversized = await fetch(`${started.url}/api/projects/${project.id}/files`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ path: 'brief.md', text: 'this upload is well over the sixty four byte ceiling' }),
    });
    expect(oversized.status).toBe(413);
    const tiny = await fetch(`${started.url}/api/projects/${project.id}/files`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify({ path: 'a.md', text: 'ok' }),
    });
    expect(tiny.status).toBe(201);
  });
});
