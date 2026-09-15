import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_OPERATIONAL_LIMITS } from '@atlas-vnext/contracts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function urlPath(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
}

export function urlQuery(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
}

export function isMutating(method?: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
}

export function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function readRaw(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) throw new Error('Request body too large.');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function readJson(
  req: IncomingMessage,
  maxBytes = DEFAULT_OPERATIONAL_LIMITS.maxRequestBytes,
): Promise<Record<string, unknown>> {
  const raw = (await readRaw(req, maxBytes)).toString('utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('JSON object body required.');
  }
  return parsed as Record<string, unknown>;
}

export function serveStatic(res: ServerResponse, staticDir: string, pathname: string): boolean {
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

export function publicFile(file: {
  id: string;
  path: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  workspaceId: string;
}): Record<string, unknown> {
  return {
    id: file.id,
    path: file.path,
    displayName: file.displayName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    contentHash: file.contentHash,
    status: file.status,
    version: file.version,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    projectId: file.workspaceId,
  };
}
