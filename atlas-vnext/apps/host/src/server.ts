import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { ConversationRuntime } from '@atlas-vnext/conversation';

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
}

export function createHost(options: HostOptions): Server {
  return createServer((req, res) => {
    void handle(req, res, options);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, options: HostOptions): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      json(res, 200, { ok: true, service: 'atlas-vnext-host' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/conversations') {
      const body = await readJson(req);
      const conversation = await options.runtime.createConversation({
        title: typeof body.title === 'string' ? body.title : undefined,
      });
      json(res, 201, conversation);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/conversations') {
      json(res, 200, await options.runtime.listConversations());
      return;
    }
    const conversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (req.method === 'GET' && conversationMatch) {
      const snapshot = await options.runtime.getSnapshot(decodeURIComponent(conversationMatch[1]!));
      if (!snapshot) {
        json(res, 404, { error: 'Conversation not found.' });
        return;
      }
      json(res, 200, snapshot);
      return;
    }
    const messageMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (req.method === 'POST' && messageMatch) {
      const body = await readJson(req);
      const content = typeof body.content === 'string' ? body.content : '';
      const capability = typeof body.capability === 'string' ? body.capability : 'nexus/fast';
      sseHeaders(res);
      for await (const event of options.runtime.sendMessage(decodeURIComponent(messageMatch[1]!), {
        content,
        capability,
      })) {
        writeSse(res, event.type, event);
        if (req.destroyed) break;
      }
      res.end();
      return;
    }
    const cancelMatch = url.pathname.match(/^\/api\/executions\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const execution = await options.runtime.cancel(decodeURIComponent(cancelMatch[1]!));
      json(res, 200, execution);
      return;
    }

    if (req.method === 'GET' && options.staticDir) {
      if (serveStatic(res, options.staticDir, url.pathname)) return;
    }

    json(res, 404, { error: 'Not found.' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      json(res, 500, { error: message });
      return;
    }
    writeSse(res, 'error', { type: 'error', failure: { code: 'host_error', message, retryable: false, at: new Date().toISOString() } });
    res.end();
  }
}

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
