import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { ConversationRuntime } from '@atlas-vnext/conversation';
import type { ProviderHealth } from '@atlas-vnext/contracts';
import { sanitizeText, type RuntimeSnapshot } from '@atlas-vnext/execution';
import type { AuthService } from '@atlas-vnext/auth';
import type { ToolEngine } from '@atlas-vnext/tools';
import { CsrfError, OriginError, AuthenticationError } from '@atlas-vnext/auth';
import { DEFAULT_OPERATIONAL_LIMITS } from '@atlas-vnext/contracts';
import { readiness, SECURITY_HEADERS, type HealthProbe, type ShutdownController } from './ops.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface HostOptions {
  runtime: ConversationRuntime;
  staticDir?: string;
  health?: {
    mode: string;
    providers: Record<string, ProviderHealth>;
    runtime?: RuntimeSnapshot | null | (() => RuntimeSnapshot | null);
  };
  probe?: HealthProbe;
  shutdown?: ShutdownController;
  auth?: AuthService;
  tools?: ToolEngine;
  tenantId?: string;
  principalId?: string;
  maxRequestBytes?: number;
  allowedOrigins?: string[];
}

export function createHost(options: HostOptions): Server {
  return createServer((req, res) => {
    void handle(req, res, options);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, options: HostOptions): Promise<void> {
  applySecurityHeaders(res);
  cors(res, req, options.allowedOrigins);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (options.shutdown && !options.shutdown.accepting && isMutating(req.method)) {
      json(res, 503, { error: 'shutting_down' });
      return;
    }

    if (req.method === 'GET' && urlPath(req) === '/api/health/live') {
      json(res, 200, { live: true, ok: true });
      return;
    }
    if (req.method === 'GET' && urlPath(req) === '/api/health/ready') {
      if (!options.probe) {
        json(res, 200, { ready: true, live: true, dependencies: {} });
        return;
      }
      const result = await readiness(options.probe);
      const accepting = options.shutdown?.accepting ?? true;
      const ready = result.ready && accepting;
      json(res, ready ? 200 : 503, { ...result, ready, accepting });
      return;
    }
    if (req.method === 'GET' && urlPath(req) === '/api/health') {
      const runtime =
        typeof options.health?.runtime === 'function' ? options.health.runtime() : (options.health?.runtime ?? null);
      const probed = options.probe ? await readiness(options.probe) : null;
      json(res, 200, {
        ok: true,
        service: 'atlas-vnext-host',
        mode: options.health?.mode ?? 'unknown',
        providers: options.health?.providers ?? {},
        runtime,
        live: probed?.live ?? true,
        ready: probed ? probed.ready && (options.shutdown?.accepting ?? true) : true,
        dependencies: probed?.dependencies ?? null,
      });
      return;
    }

    await enforceCsrfIfNeeded(req, options);

    if (req.method === 'POST' && urlPath(req) === '/api/conversations') {
      const body = await readJson(req, options.maxRequestBytes);
      const conversation = await options.runtime.createConversation({
        title: typeof body.title === 'string' ? body.title : undefined,
      });
      json(res, 201, conversation);
      return;
    }
    if (req.method === 'GET' && urlPath(req) === '/api/conversations') {
      json(res, 200, await options.runtime.listConversations());
      return;
    }
    const pathname = urlPath(req);
    const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (req.method === 'GET' && conversationMatch) {
      const snapshot = await options.runtime.getSnapshot(decodeURIComponent(conversationMatch[1]!));
      if (!snapshot) {
        json(res, 404, { error: 'Conversation not found.' });
        return;
      }
      json(res, 200, snapshot);
      return;
    }
    const messageMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (req.method === 'POST' && messageMatch) {
      const body = await readJson(req, options.maxRequestBytes);
      const content = typeof body.content === 'string' ? body.content : '';
      const capability = typeof body.capability === 'string' ? body.capability : 'nexus/fast';
      sseHeaders(res);
      for await (const event of options.runtime.sendMessage(decodeURIComponent(messageMatch[1]!), {
        content,
        capability,
      })) {
        writeSse(res, event.type, event);
        if (res.destroyed) break;
      }
      res.end();
      return;
    }
    const cancelMatch = pathname.match(/^\/api\/executions\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const execution = await options.runtime.cancel(decodeURIComponent(cancelMatch[1]!));
      json(res, 200, execution);
      return;
    }

    const toolMatch = pathname.match(/^\/api\/tools\/([^/]+)$/);
    if (req.method === 'GET' && toolMatch && options.tools && options.tenantId && options.principalId) {
      const invocation = await options.tools.get(
        { tenantId: options.tenantId, principalId: options.principalId },
        decodeURIComponent(toolMatch[1]!),
      );
      if (!invocation) {
        json(res, 404, { error: 'Permission denied.' });
        return;
      }
      json(res, 200, invocation);
      return;
    }
    const approveMatch = pathname.match(/^\/api\/tools\/([^/]+)\/(approve|deny)$/);
    if (req.method === 'POST' && approveMatch && options.tools && options.tenantId && options.principalId) {
      const body = await readJson(req, options.maxRequestBytes);
      const result = await options.tools.approve(
        { tenantId: options.tenantId, principalId: options.principalId },
        decodeURIComponent(approveMatch[1]!),
        approveMatch[2] === 'approve' ? 'approved' : 'denied',
        typeof body.reason === 'string' ? body.reason : undefined,
      );
      json(res, 200, { invocation: result.invocation, output: result.output ?? null });
      return;
    }

    if (req.method === 'GET' && options.staticDir) {
      if (serveStatic(res, options.staticDir, pathname)) return;
    }

    json(res, 404, { error: 'Not found.' });
  } catch (err) {
    if (err instanceof CsrfError || err instanceof OriginError || err instanceof AuthenticationError) {
      json(res, err instanceof AuthenticationError && err.code === 'unauthenticated' ? 401 : 403, {
        error: err.message,
      });
      return;
    }
    const message = sanitizeText(err instanceof Error ? err.message : String(err));
    if (!res.headersSent) {
      json(res, 500, { error: message });
      return;
    }
    writeSse(res, 'error', {
      type: 'error',
      failure: { code: 'host_error', message, retryable: false, at: new Date().toISOString() },
    });
    res.end();
  }
}

function urlPath(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
}

function isMutating(method?: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

async function enforceCsrfIfNeeded(req: IncomingMessage, options: HostOptions): Promise<void> {
  if (!options.auth || !isMutating(req.method)) return;
  const cookie = options.auth.parseCookie(header(req, 'cookie'));
  if (!cookie) return;
  await options.auth.resolve({
    sessionId: cookie,
    csrfToken: header(req, options.auth.csrfHeader),
    origin: header(req, 'origin'),
    mutating: true,
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function applySecurityHeaders(res: ServerResponse): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }
}

function cors(res: ServerResponse, req: IncomingMessage, allowedOrigins?: string[]): void {
  const origin = header(req, 'origin');
  if (allowedOrigins?.length) {
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-atlas-csrf');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(': connected\n\n');
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readJson(req: IncomingMessage, maxBytes = DEFAULT_OPERATIONAL_LIMITS.maxRequestBytes): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) throw new Error('Request body too large.');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('JSON object body required.');
  }
  return parsed as Record<string, unknown>;
}

function serveStatic(res: ServerResponse, staticDir: string, pathname: string): boolean {
  const root = resolve(staticDir);
  const relativePath = pathname === '/' ? '/index.html' : pathname;
  const candidate = resolve(root, `.${normalize(relativePath)}`);
  if (!candidate.startsWith(root)) return false;
  const filePath = existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(root, 'index.html');
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
  res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
  return true;
}

export async function listen(server: Server, port = 0, host = '127.0.0.1'): Promise<{ port: number; url: string }> {
  await new Promise<void>((resolveListen, reject) => {
    server.listen(port, host, () => resolveListen());
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind host server.');
  }
  return { port: address.port, url: `http://${host}:${address.port}` };
}
