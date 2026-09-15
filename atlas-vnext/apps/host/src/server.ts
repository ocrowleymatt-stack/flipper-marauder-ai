import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { GeneratedOutputLimitError, type ConversationRuntime } from '@atlas-vnext/conversation';
import type { ProviderHealth } from '@atlas-vnext/contracts';
import { sanitizeText, type RuntimeSnapshot } from '@atlas-vnext/execution';
import type { AuthService } from '@atlas-vnext/auth';
import { CsrfError, OriginError, AuthenticationError } from '@atlas-vnext/auth';
import type { ContextService } from '@atlas-vnext/context';
import type { FilesService } from '@atlas-vnext/files';
import { CasMissingError } from '@atlas-vnext/files';
import type { PlatformPersistence } from '@atlas-vnext/persistence';
import {
  ConflictError,
  OwnershipError,
  PersistenceClosedError,
  PersistenceUnavailableError,
  PersistenceUncertainError,
  isPersistenceConnectionLoss,
} from '@atlas-vnext/persistence';
import type { ProjectService } from '@atlas-vnext/projects';
import type { ToolEngine } from '@atlas-vnext/tools';
import { ToolError } from '@atlas-vnext/tools';
import { DEFAULT_OPERATIONAL_LIMITS } from '@atlas-vnext/contracts';
import type { EnvFlagStore, KillSwitchState } from '@atlas-vnext/flags';
import {
  classifyRoute,
  createRequestId,
  logPlatform,
  patchRequestContext,
  platformMetrics,
  runWithRequestContext,
} from '@atlas-vnext/observability';
import { readiness, securityHeaders, type HealthProbe, type ShutdownController } from './ops.ts';
import {
  header,
  isMutating,
  json,
  matchingOrigin,
  readJson,
  serveStatic,
  sseHeaders,
  urlPath,
  urlQuery,
  writeSse,
} from './http.ts';
import { acquireRunAndStreamPermits, pipeSse } from './sse.ts';
import {
  conversationSessionMissing,
  handleWorkbench,
  isForeignHostSession,
  resolveActor,
} from './workbench.ts';
import { handleCaspa } from './caspa.ts';
import type { WritingService } from '@atlas-vnext/dungeon-writing';
import { PlatformHttpError, GENERIC_DENIED, httpStatusFor, type PlatformErrorCode } from './errors.ts';
import { PlatformRateLimiter, ResourceGuard, rateClassForPath, resolveRateLimitIdentity } from './limits.ts';
import { SINGLE_INSTANCE_TOPOLOGY, type TimeoutContract } from './production-config.ts';

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
  writing?: WritingService | null;
  tenantId?: string;
  principalId?: string;
  production?: boolean;
  maxRequestBytes?: number;
  maxUploadBytes?: number;
  allowedOrigins?: string[];
  flags?: EnvFlagStore;
  killSwitches?: KillSwitchState;
  rateLimiter?: PlatformRateLimiter;
  resources?: ResourceGuard;
  hsts?: boolean;
  timeouts?: TimeoutContract;
}

export function createHost(options: HostOptions): Server {
  const server = createServer((req, res) => {
    const started = Date.now();
    const requestId = createRequestId(header(req, 'x-request-id'));
    const pathname = urlPath(req);
    void runWithRequestContext({ requestId, route: pathname }, async () => {
      try {
        await handle(req, res, options);
        platformMetrics.inc('atlas_http_requests_total', {
          route_class: classifyRoute(pathname),
          outcome: String(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'reject' : 'ok'),
        });
        platformMetrics.observeMs('atlas_http_latency_ms', Date.now() - started, {
          route_class: classifyRoute(pathname),
        });
      } catch (err) {
        writeClassifiedError(res, err);
        platformMetrics.inc('atlas_http_requests_total', {
          route_class: classifyRoute(pathname),
          outcome: 'error',
        });
      }
    });
  });
  applyInboundHttpTimeouts(server, options.timeouts?.httpMs);
  return server;
}

/**
 * Bound slow/stalled inbound request receipt (headers + body).
 *
 * `requestTimeout` and `headersTimeout` are set on the Node server. Socket
 * inactivity (`server.timeout`) is what actually closes a stalled inbound
 * connection in current Node; that timer is cleared once the request body has
 * been received so legitimate SSE responses are governed by
 * `ATLAS_STREAM_IDLE_TIMEOUT_MS` rather than this inbound bound.
 */
export function applyInboundHttpTimeouts(server: Server, httpMs?: number): void {
  if (!httpMs || httpMs <= 0) return;
  server.requestTimeout = httpMs;
  if (server.headersTimeout === 0 || server.headersTimeout > httpMs) {
    server.headersTimeout = httpMs;
  }
  server.timeout = httpMs;
  server.on('request', (req, res) => {
    const socket = req.socket;
    if (!socket) return;
    const clearInbound = (): void => {
      if (!socket.destroyed) socket.setTimeout(0);
    };
    const rearmInbound = (): void => {
      if (!socket.destroyed) socket.setTimeout(httpMs);
    };
    if (req.readableEnded) clearInbound();
    else req.once('end', clearInbound);
    res.once('close', rearmInbound);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, options: HostOptions): Promise<void> {
  applySecurityHeaders(res, options.hsts === true);
  cors(res, req, options);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (options.shutdown && !options.shutdown.accepting && isMutating(req.method)) {
      json(res, 503, { error: 'shutting_down', code: 'shutting_down' });
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
      const result = await readiness(options.probe, options.production === true);
      const accepting = options.shutdown?.accepting ?? true;
      const ready = result.ready && accepting;
      json(res, ready ? 200 : 503, { ...result, ready, accepting, ...SINGLE_INSTANCE_TOPOLOGY });
      return;
    }
    if (req.method === 'GET' && urlPath(req) === '/api/health') {
      const runtime =
        typeof options.health?.runtime === 'function' ? options.health.runtime() : (options.health?.runtime ?? null);
      const probed = options.probe ? await readiness(options.probe, options.production === true) : null;
      const accepting = options.shutdown?.accepting ?? true;
      const ready = probed ? probed.ready && accepting : accepting;
      json(res, ready ? 200 : 503, {
        ok: ready,
        service: 'atlas-vnext-host',
        mode: options.health?.mode ?? 'unknown',
        providers: options.health?.providers ?? {},
        runtime,
        live: probed?.live ?? true,
        ready,
        dependencies: probed?.dependencies ?? null,
        ...SINGLE_INSTANCE_TOPOLOGY,
      });
      return;
    }
    if (req.method === 'GET' && urlPath(req) === '/api/metrics') {
      json(res, 200, platformMetrics.snapshot());
      return;
    }

    await enforceCsrfIfNeeded(req, options);
    await enforceRateLimit(req, options);
    enforceKillSwitch(req, options);

    if (await handleWorkbench(req, res, options)) return;
    if (await handleCaspa(req, res, options)) return;

    const conversationActor = await resolveActor(req, options);
    if (conversationActor) {
      patchRequestContext({ tenantId: conversationActor.tenantId, actorId: conversationActor.principalId });
    }

    if (req.method === 'POST' && urlPath(req) === '/api/conversations') {
      if (conversationSessionMissing(conversationActor, options)) {
        json(res, 401, { error: 'Authentication required.', code: 'unauthenticated' });
        return;
      }
      if (isForeignHostSession(conversationActor, options)) {
        json(res, 404, { error: GENERIC_DENIED, code: 'not_found' });
        return;
      }
      const body = await readJson(req, options.maxRequestBytes);
      const projectId = typeof body.projectId === 'string' ? body.projectId : undefined;
      if (projectId) {
        const actor = conversationActor;
        if (!actor) {
          json(res, 401, { error: 'Authentication required.', code: 'unauthenticated' });
          return;
        }
        if (!options.projects) {
          json(res, 503, { error: 'Projects require platform persistence.', code: 'persistence_unavailable' });
          return;
        }
        const project = await options.projects.get(actor, projectId);
        if (!project) {
          json(res, 404, { error: 'Project not found.', code: 'not_found' });
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
        json(res, 401, { error: 'Authentication required.', code: 'unauthenticated' });
        return;
      }
      if (isForeignHostSession(conversationActor, options)) {
        json(res, 404, { error: 'Conversation not found.', code: 'not_found' });
        return;
      }
      const snapshot = await options.runtime.getSnapshot(decodeURIComponent(conversationMatch[1]!));
      if (!snapshot) {
        json(res, 404, { error: 'Conversation not found.', code: 'not_found' });
        return;
      }
      json(res, 200, snapshot);
      return;
    }
    const messageMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (req.method === 'POST' && messageMatch) {
      if (conversationSessionMissing(conversationActor, options)) {
        json(res, 401, { error: 'Authentication required.', code: 'unauthenticated' });
        return;
      }
      if (isForeignHostSession(conversationActor, options)) {
        json(res, 404, { error: 'Conversation not found.', code: 'not_found' });
        return;
      }
      if (options.killSwitches && !options.killSwitches.generation) {
        json(res, 503, { error: 'Generation is disabled.', code: 'kill_switch' });
        return;
      }
      const body = await readJson(req, options.maxRequestBytes);
      const content = typeof body.content === 'string' ? body.content : '';
      const capability = typeof body.capability === 'string' ? body.capability : 'nexus/fast';
      const origin = matchingOrigin(req, options.allowedOrigins);
      const tenantKey = conversationActor?.tenantId ?? options.tenantId ?? 'local';
      const conversationId = decodeURIComponent(messageMatch[1]!);
      const releaseAdmission = acquireRunAndStreamPermits(options.resources, tenantKey);
      sseHeaders(res, origin);
      try {
        await pipeSse(
          res,
          options.runtime.sendMessage(conversationId, { content, capability }),
          options.timeouts?.streamIdleMs ?? 120_000,
          async (executionId) => {
            if (!executionId) return;
            try {
              await options.runtime.cancel(executionId);
            } catch {
              // Cancel is best-effort and idempotent; admission still releases below.
            }
          },
          options.resources?.generatedByteLimit() ?? DEFAULT_OPERATIONAL_LIMITS.maxGeneratedBytes,
        );
      } finally {
        releaseAdmission();
      }
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
        json(res, 401, { error: 'Authentication required.', code: 'unauthenticated' });
        return;
      }
      const presented = await options.tools.presentById(actor, decodeURIComponent(toolMatch[1]!));
      if (!presented) {
        json(res, 404, { error: GENERIC_DENIED, code: 'not_found' });
        return;
      }
      json(res, 200, presented);
      return;
    }
    const approveMatch = pathname.match(/^\/api\/tools\/([^/]+)\/(approve|deny)$/);
    if (req.method === 'POST' && approveMatch && options.tools) {
      const actor = await resolveActor(req, options);
      if (!actor) {
        json(res, 401, { error: 'Authentication required.', code: 'unauthenticated' });
        return;
      }
      if (options.killSwitches && !options.killSwitches.tools) {
        json(res, 503, { error: 'Tools are disabled.', code: 'kill_switch' });
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

    json(res, 404, { error: 'Not found.', code: 'not_found' });
  } catch (err) {
    writeClassifiedError(res, err);
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

async function enforceRateLimit(req: IncomingMessage, options: HostOptions): Promise<void> {
  if (!options.rateLimiter) return;
  const pathname = urlPath(req);
  const rateClass = rateClassForPath(pathname, req.method ?? 'GET');
  if (!rateClass) return;
  const actor = await resolveActor(req, options).catch(() => null);
  const identity = resolveRateLimitIdentity({
    actor,
    authWired: Boolean(options.auth),
    pathname,
    remoteAddress: req.socket?.remoteAddress,
  });
  options.rateLimiter.hit(rateClass, identity.tenantId, identity.actorId);
}

function enforceKillSwitch(req: IncomingMessage, options: HostOptions): void {
  const flags = options.killSwitches;
  if (!flags) return;
  const pathname = urlPath(req);
  if (!flags.tools && (pathname.startsWith('/api/tools') || pathname.startsWith('/api/approvals'))) {
    throw new PlatformHttpError('kill_switch', 'Tools are disabled.', 503);
  }
  if (!flags.generation && (pathname.includes('/messages') || pathname.includes('/generate'))) {
    throw new PlatformHttpError('kill_switch', 'Generation is disabled.', 503);
  }
  if (!flags.dungeonWriting && (pathname.includes('/documents') || pathname === '/api/dungeons')) {
    throw new PlatformHttpError('kill_switch', 'Writing dungeon is disabled.', 503);
  }
}

function applySecurityHeaders(res: ServerResponse, hsts: boolean): void {
  for (const [key, value] of Object.entries(securityHeaders({ hsts }))) {
    res.setHeader(key, value);
  }
}

function cors(res: ServerResponse, req: IncomingMessage, options: HostOptions): void {
  const origin = header(req, 'origin');
  if (options.allowedOrigins?.length) {
    if (origin && options.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    } else {
      res.setHeader('Vary', 'Origin');
    }
  } else if (!options.production && !options.auth) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-atlas-csrf, x-request-id');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
}

function writeClassifiedError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    const message = sanitizeText(err instanceof Error ? err.message : String(err));
    writeSse(res, 'error', {
      type: 'error',
      failure: { code: classifyError(err).code, message, retryable: false, at: new Date().toISOString() },
    });
    res.end();
    return;
  }
  const classified = classifyError(err);
  json(res, classified.status, { error: classified.message, code: classified.code });
}

function classifyError(err: unknown): { status: number; code: PlatformErrorCode; message: string } {
  if (err instanceof PlatformHttpError) {
    return { status: err.httpStatus, code: err.code, message: err.message };
  }
  if (err instanceof CsrfError || err instanceof OriginError) {
    return { status: 403, code: 'unauthorised', message: err.message };
  }
  if (err instanceof AuthenticationError) {
    return {
      status: err.code === 'unauthenticated' ? 401 : 403,
      code: err.code === 'unauthenticated' ? 'unauthenticated' : 'unauthorised',
      message: err.message,
    };
  }
  if (err instanceof OwnershipError) {
    return { status: 404, code: 'not_found', message: GENERIC_DENIED };
  }
  if (err instanceof CasMissingError) {
    return { status: 503, code: 'cas_unavailable', message: 'CAS object missing.' };
  }
  if (err instanceof PersistenceUnavailableError) {
    return { status: 503, code: 'persistence_unavailable', message: 'Persistence unavailable.' };
  }
  if (err instanceof PersistenceUncertainError) {
    return { status: 500, code: 'persistence_uncertain', message: 'Persistence outcome is uncertain.' };
  }
  if (err instanceof PersistenceClosedError) {
    return { status: 503, code: 'shutting_down', message: 'Persistence is shut down.' };
  }
  if (err instanceof GeneratedOutputLimitError) {
    return { status: 413, code: 'payload_too_large', message: err.message };
  }
  if (isPersistenceConnectionLoss(err)) {
    return { status: 503, code: 'persistence_unavailable', message: 'Persistence unavailable.' };
  }
  if (err instanceof ConflictError) {
    return { status: 409, code: 'conflict', message: 'Conflict.' };
  }
  if (err instanceof ToolError) {
    const code: PlatformErrorCode =
      err.code === 'rate_limit'
        ? 'rate_limit'
        : err.code === 'uncertain' || err.code === 'interrupted_uncertain'
          ? 'tool_uncertain'
          : err.message === 'Permission denied.' || err.code === 'not_found' || err.code === 'permission_denied'
            ? 'not_found'
            : 'validation';
    const status = code === 'not_found' ? 404 : httpStatusFor(code) === 500 ? 400 : httpStatusFor(code);
    return { status, code, message: code === 'not_found' ? GENERIC_DENIED : err.message };
  }
  if (err instanceof SyntaxError) {
    return { status: 400, code: 'validation', message: 'Malformed JSON.' };
  }
  if (err instanceof Error && err.message === 'Request body too large.') {
    return { status: 413, code: 'payload_too_large', message: err.message };
  }
  const message = sanitizeText(err instanceof Error ? err.message : String(err));
  logPlatform('http.unhandled', { error: message }, 'error');
  return { status: 500, code: 'internal', message };
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
