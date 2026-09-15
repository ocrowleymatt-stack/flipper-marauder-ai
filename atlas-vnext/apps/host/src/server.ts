import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ConversationRuntime } from '@atlas-vnext/conversation';
import type { ProviderHealth } from '@atlas-vnext/contracts';
import { sanitizeText, type RuntimeSnapshot } from '@atlas-vnext/execution';
import type { AuthService } from '@atlas-vnext/auth';
import { CsrfError, OriginError, AuthenticationError } from '@atlas-vnext/auth';
import type { ContextService } from '@atlas-vnext/context';
import type { FilesService } from '@atlas-vnext/files';
import type { PlatformPersistence } from '@atlas-vnext/persistence';
import type { ProjectService } from '@atlas-vnext/projects';
import type { ToolEngine } from '@atlas-vnext/tools';
import { ToolError } from '@atlas-vnext/tools';
import { DEFAULT_OPERATIONAL_LIMITS } from '@atlas-vnext/contracts';
import { readiness, SECURITY_HEADERS, type HealthProbe, type ShutdownController } from './ops.ts';
import {
  header,
  isMutating,
  json,
  readJson,
  serveStatic,
  sseHeaders,
  urlPath,
  urlQuery,
  writeSse,
} from './http.ts';
import {
  conversationSessionMissing,
  handleWorkbench,
  isForeignHostSession,
  resolveActor,
} from './workbench.ts';

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
  projects?: ProjectService | null;
  files?: FilesService | null;
  context?: ContextService | null;
  persistence?: PlatformPersistence | null;
  tenantId?: string;
  principalId?: string;
  production?: boolean;
  maxRequestBytes?: number;
  maxUploadBytes?: number;
  allowedOrigins?: string[];
}

export function createHost(options: HostOptions): Server {
  return createServer((req, res) => {
    void handle(req, res, options);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, options: HostOptions): Promise<void> {
  applySecurityHeaders(res);
  cors(res, req, options);
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

    if (await handleWorkbench(req, res, options)) return;

    const conversationActor = await resolveActor(req, options);

    if (req.method === 'POST' && urlPath(req) === '/api/conversations') {
      if (conversationSessionMissing(conversationActor, options)) {
        json(res, 401, { error: 'Authentication required.' });
        return;
      }
      if (isForeignHostSession(conversationActor, options)) {
        json(res, 404, { error: 'Permission denied.' });
        return;
      }
      const body = await readJson(req, options.maxRequestBytes);
      const projectId = typeof body.projectId === 'string' ? body.projectId : undefined;
      if (projectId) {
        const actor = conversationActor;
        if (!actor) {
          json(res, 401, { error: 'Authentication required.' });
          return;
        }
        if (!options.projects) {
          json(res, 503, { error: 'Projects require platform persistence.' });
          return;
        }
        const project = await options.projects.get(actor, projectId);
        if (!project) {
          json(res, 404, { error: 'Project not found.' });
          return;
        }
      }
      const conversation = await options.runtime.createConversation({
        title: typeof body.title === 'string' ? body.title : undefined,
        projectId: projectId ?? null,
      });
      json(res, 201, conversation);
      return;
    }
    if (req.method === 'GET' && urlPath(req) === '/api/conversations') {
      if (conversationSessionMissing(conversationActor, options)) {
        json(res, 401, { error: 'Authentication required.' });
        return;
      }
      if (isForeignHostSession(conversationActor, options)) {
        json(res, 200, []);
        return;
      }
      const projectId = urlQuery(req).get('projectId');
      const conversations = await options.runtime.listConversations();
      json(
        res,
        200,
        projectId
          ? conversations.filter((item) => item.projectId === projectId || item.workspaceId === projectId)
          : conversations,
      );
      return;
    }
    const pathname = urlPath(req);
    const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (req.method === 'GET' && conversationMatch) {
      if (conversationSessionMissing(conversationActor, options)) {
        json(res, 401, { error: 'Authentication required.' });
        return;
      }
      if (isForeignHostSession(conversationActor, options)) {
        json(res, 404, { error: 'Conversation not found.' });
        return;
      }
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
      if (conversationSessionMissing(conversationActor, options)) {
        json(res, 401, { error: 'Authentication required.' });
        return;
      }
      if (isForeignHostSession(conversationActor, options)) {
        json(res, 404, { error: 'Conversation not found.' });
        return;
      }
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
      if (conversationSessionMissing(conversationActor, options)) {
        json(res, 401, { error: 'Authentication required.' });
        return;
      }
      if (isForeignHostSession(conversationActor, options)) {
        json(res, 404, { error: 'Execution not found.' });
        return;
      }
      const execution = await options.runtime.cancel(decodeURIComponent(cancelMatch[1]!));
      json(res, 200, execution);
      return;
    }

    const toolMatch = pathname.match(/^\/api\/tools\/([^/]+)$/);
    if (req.method === 'GET' && toolMatch && options.tools) {
      const actor = await resolveActor(req, options);
      if (!actor) {
        json(res, 401, { error: 'Authentication required.' });
        return;
      }
      const presented = await options.tools.presentById(actor, decodeURIComponent(toolMatch[1]!));
      if (!presented) {
        json(res, 404, { error: 'Permission denied.' });
        return;
      }
      json(res, 200, presented);
      return;
    }
    const approveMatch = pathname.match(/^\/api\/tools\/([^/]+)\/(approve|deny)$/);
    if (req.method === 'POST' && approveMatch && options.tools) {
      const actor = await resolveActor(req, options);
      if (!actor) {
        json(res, 401, { error: 'Authentication required.' });
        return;
      }
      const body = await readJson(req, options.maxRequestBytes);
      const result = await options.tools.approve(
        actor,
        decodeURIComponent(approveMatch[1]!),
        approveMatch[2] === 'approve' ? 'approved' : 'denied',
        typeof body.reason === 'string' ? body.reason : undefined,
      );
      json(res, 200, {
        invocation: await options.tools.present(actor, result.invocation),
        output: result.output ?? null,
      });
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
    if (err instanceof ToolError) {
      json(res, err.message === 'Permission denied.' || err.code === 'not_found' ? 404 : 400, { error: err.message });
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

async function enforceCsrfIfNeeded(req: IncomingMessage, options: HostOptions): Promise<void> {
  if (!options.auth || !isMutating(req.method)) return;
  const pathname = urlPath(req);
  if (pathname === '/api/session' || pathname === '/api/session/revoke') return;
  const cookie = options.auth.parseCookie(header(req, 'cookie'));
  if (!cookie) return;
  await options.auth.resolve({
    sessionId: cookie,
    csrfToken: header(req, options.auth.csrfHeader),
    origin: header(req, 'origin'),
    mutating: true,
  });
}

function applySecurityHeaders(res: ServerResponse): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }
}

function cors(res: ServerResponse, req: IncomingMessage, options: HostOptions): void {
  const origin = header(req, 'origin');
  const allowedOrigins = options.allowedOrigins;
  if (allowedOrigins?.length) {
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    } else {
      res.setHeader('Vary', 'Origin');
    }
  } else if (!options.auth) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-atlas-csrf');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
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

void DEFAULT_OPERATIONAL_LIMITS;
