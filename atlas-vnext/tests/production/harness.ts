import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { PersistenceConfig } from '@atlas-vnext/persistence';
import { composeSpine, createHost, grantSideEffects, listen, type Spine } from '../../apps/host/src/index.ts';

export function memoryConfig(tenantId: string): PersistenceConfig {
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

export async function startProductionHost(input: {
  tenantId?: string;
  env?: Record<string, string | undefined>;
  production?: boolean;
  allowedOrigins?: string[];
  grant?: boolean;
} = {}): Promise<{ url: string; port: number; spine: Spine; server: Server; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-prod-'));
  const tenantId = input.tenantId ?? 'tenant_a';
  const spine = await composeSpine({
    dataPath: join(dir, 'state.json'),
    mode: 'mock',
    persistence: memoryConfig(tenantId),
    casRoot: join(dir, 'cas'),
    env: {
      ATLAS_TENANT_ID: tenantId,
      ATLAS_SESSION_SECRET: 'test-session-secret-not-for-production-use',
      ...input.env,
    },
  });
  if (input.grant !== false) grantSideEffects(spine.authority, spine.principalId, spine.tenantId);
  const server = createHost({
    runtime: spine.runtime,
    auth: spine.auth,
    tools: spine.tools,
    projects: spine.projects,
    files: spine.files,
    context: spine.context,
    persistence: spine.persistence,
    writing: spine.writing,
    tenantId: spine.tenantId,
    principalId: spine.principalId,
    production: input.production ?? false,
    allowedOrigins: input.allowedOrigins,
    flags: spine.flags,
    killSwitches: spine.killSwitches,
    rateLimiter: spine.rateLimiter,
    resources: spine.resources,
    timeouts: spine.timeouts,
    probe: spine.healthProbe,
    shutdown: spine.shutdown,
    health: { mode: spine.mode, providers: spine.health, runtime: () => spine.runtimeSnapshot() },
    hsts: input.production === true,
  });
  const bound = await listen(server, 0, '127.0.0.1');
  return { ...bound, spine, server, dir };
}

export async function bootstrap(url: string): Promise<{ cookie: string; csrf: string }> {
  const response = await fetch(`${url}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = (await response.json()) as { csrfToken: string };
  return { cookie: response.headers.get('set-cookie') ?? '', csrf: body.csrfToken };
}

export function authHeaders(session: { cookie: string; csrf: string }, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    cookie: session.cookie,
    'x-atlas-csrf': session.csrf,
    ...extra,
  };
}

export async function readSse(response: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await response.text();
  const frames: Array<{ event: string; data: unknown }> = [];
  let currentEvent = 'message';
  for (const line of text.split('\n')) {
    if (line.startsWith('event: ')) currentEvent = line.slice(7).trim();
    else if (line.startsWith('data: ')) {
      frames.push({ event: currentEvent, data: JSON.parse(line.slice(6)) });
      currentEvent = 'message';
    }
  }
  return frames;
}
