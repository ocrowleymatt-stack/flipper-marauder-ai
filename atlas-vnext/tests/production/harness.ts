import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { InspectedSource, SourceInspectPort } from '@atlas-vnext/contracts';
import type { PersistenceConfig } from '@atlas-vnext/persistence';
import {
  composeSpine,
  createHost,
  grantSideEffects,
  listen,
  type PlatformRateLimiter,
  type Spine,
} from '../../apps/host/src/index.ts';

export const PRODUCTION_ORIGIN = 'https://atlas.ocrowley.com';
export const OPERATOR_PASSWORD = 'correct-horse-battery-staple';

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

export function octocatInspect(): SourceInspectPort {
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

export async function startProductionHost(input: {
  tenantId?: string;
  env?: Record<string, string | undefined>;
  production?: boolean;
  allowedOrigins?: string[];
  grant?: boolean;
  streamDelayMs?: number;
  rateLimiter?: PlatformRateLimiter;
  persistence?: PersistenceConfig;
  osintInspect?: SourceInspectPort;
  provisionLogin?: boolean;
} = {}): Promise<{ url: string; port: number; spine: Spine; server: Server; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-prod-'));
  const tenantId = input.tenantId ?? 'tenant_a';
  const allowedOrigins = input.allowedOrigins ?? (input.production ? [PRODUCTION_ORIGIN] : undefined);
  const spine = await composeSpine({
    dataPath: join(dir, 'state.json'),
    mode: 'mock',
    persistence: input.persistence ?? memoryConfig(tenantId),
    casRoot: join(dir, 'cas'),
    streamDelayMs: input.streamDelayMs ?? 0,
    osintInspect: input.osintInspect,
    env: {
      ATLAS_TENANT_ID: tenantId,
      ATLAS_SESSION_SECRET: 'test-session-secret-not-for-production-use',
      ATLAS_ALLOWED_ORIGINS: allowedOrigins?.join(',') ?? '',
      ...input.env,
    },
  });
  if (input.grant !== false) grantSideEffects(spine.authority, spine.principalId, spine.tenantId);
  if (input.provisionLogin) {
    await spine.login.provision({
      principalId: spine.principalId,
      login: 'owner',
      password: OPERATOR_PASSWORD,
    });
  }
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
    production: input.production ?? false,
    allowedOrigins,
    flags: spine.flags,
    killSwitches: spine.killSwitches,
    rateLimiter: input.rateLimiter ?? spine.rateLimiter,
    resources: spine.resources,
    maxRequestBytes: spine.limits.maxRequestBytes,
    maxUploadBytes: spine.limits.maxUploadBytes,
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

export async function nativeLogin(
  url: string,
  input: { login?: string; password?: string; origin?: string } = {},
): Promise<{ cookie: string; csrf: string }> {
  const origin = input.origin ?? PRODUCTION_ORIGIN;
  const response = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({
      login: input.login ?? 'owner',
      password: input.password ?? OPERATOR_PASSWORD,
    }),
  });
  if (!response.ok) {
    throw new Error(`native login failed: ${response.status} ${await response.text()}`);
  }
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

export async function assistantText(response: Response): Promise<string> {
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
