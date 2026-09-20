import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthService, LoginService } from '@atlas-vnext/auth';
import { AuthenticationError, OriginError, RateLimitedError, SessionRevokedError } from '@atlas-vnext/auth';
import type { ConversationRuntime } from '@atlas-vnext/conversation';
import type { ContextService } from '@atlas-vnext/context';
import type { FilesService } from '@atlas-vnext/files';
import { CasMissingError, FilesAccessError, PathSafetyError, UnsupportedMediaError } from '@atlas-vnext/files';
import { OwnershipError, PersistenceClosedError, PersistenceUnavailableError, isPersistenceConnectionLoss } from '@atlas-vnext/persistence';
import type { PlatformPersistence } from '@atlas-vnext/persistence';
import type { ProjectService } from '@atlas-vnext/projects';
import { ToolError, type ToolEngine } from '@atlas-vnext/tools';
import { DEFAULT_OPERATIONAL_LIMITS } from '@atlas-vnext/contracts';
import { isWritingRunConversation } from '@atlas-vnext/dungeon-writing';
import { header, isMutating, json, publicFile, readJson, readRaw, sendBytes, urlPath, urlQuery } from './http.ts';
import { loginClientAddress } from './limits.ts';

export interface WorkbenchHostOptions {
  runtime: ConversationRuntime;
  auth?: AuthService;
  login?: LoginService;
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
}

export interface WorkbenchActor {
  tenantId: string;
  principalId: string;
  sessionId: string | null;
}

export function sessionOwnsHostConversations(
  actor: WorkbenchActor,
  options: WorkbenchHostOptions,
): boolean {
  if (!actor.sessionId) return true;
  if (!options.tenantId) return true;
  return actor.tenantId === options.tenantId;
}

export async function resolveActor(req: IncomingMessage, options: WorkbenchHostOptions): Promise<WorkbenchActor | null> {
  if (options.auth) {
    const cookie = options.auth.parseCookie(header(req, 'cookie'));
    if (!cookie) return null;
    try {
      const resolved = await options.auth.resolve({
        sessionId: cookie,
        csrfToken: header(req, options.auth.csrfHeader),
        origin: header(req, 'origin'),
        mutating: isMutating(req.method),
        claimedTenantId: null,
      });
      if (!resolved.actor.tenantId) return null;
      return {
        tenantId: resolved.actor.tenantId,
        principalId: resolved.actor.principalId,
        sessionId: resolved.session?.id ?? cookie,
      };
    } catch (err) {
      if (err instanceof SessionRevokedError) return null;
      if (err instanceof AuthenticationError && err.code === 'unauthenticated') return null;
      throw err;
    }
  }
  if (options.tenantId && options.principalId) {
    return { tenantId: options.tenantId, principalId: options.principalId, sessionId: null };
  }
  return null;
}

/** Cookie-free conversation access is only for hosts that did not wire auth. */
export function conversationSessionMissing(
  actor: WorkbenchActor | null,
  options: WorkbenchHostOptions,
): boolean {
  return Boolean(options.auth && !actor);
}

export function isForeignHostSession(actor: WorkbenchActor | null, options: WorkbenchHostOptions): boolean {
  return Boolean(actor && !sessionOwnsHostConversations(actor, options));
}

export function visibleHostConversations<T extends { title?: string | null }>(items: T[]): T[] {
  return items.filter((item) => !isWritingRunConversation(item.title));
}

export function expireSessionCookie(res: ServerResponse, options: WorkbenchHostOptions): void {
  if (!options.auth) return;
  const parts = [`${options.auth.cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (options.production) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export async function handleWorkbench(
  req: IncomingMessage,
  res: ServerResponse,
  options: WorkbenchHostOptions,
): Promise<boolean> {
  const pathname = urlPath(req);
  const query = urlQuery(req);

  if (req.method === 'GET' && pathname === '/api/session') {
    await handleGetSession(req, res, options);
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/session') {
    await handleIssueSession(req, res, options);
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/session/revoke') {
    await handleRevokeSession(req, res, options);
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    await handleNativeLogin(req, res, options);
    return true;
  }

  if (pathname === '/api/projects' || pathname.startsWith('/api/projects/') || pathname.startsWith('/api/files/') || pathname.startsWith('/api/context/') || pathname === '/api/approvals') {
    if (/\/(documents|osint|cases|research|sites|compositions|story-bible)(?:\/|$)/.test(pathname)) return false;
    const actor = await resolveActor(req, options);
    if (!actor) {
      json(res, 401, { error: 'Authentication required.' });
      return true;
    }
    try {
      if (req.method === 'GET' && pathname === '/api/projects') {
        json(res, 200, await requireProjects(options).list(actor));
        return true;
      }
      if (req.method === 'POST' && pathname === '/api/projects') {
        const body = await readJson(req, options.maxRequestBytes);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) {
          json(res, 400, { error: 'Project name is required.' });
          return true;
        }
        const dungeon = typeof body.dungeon === 'string' ? body.dungeon.trim() : undefined;
        const project = await requireProjects(options).create(actor, {
          name,
          description: typeof body.description === 'string' ? body.description : undefined,
          dungeon,
        });
        json(res, 201, project);
        return true;
      }
      const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (req.method === 'GET' && projectMatch) {
        const project = await requireProjects(options).get(actor, decodeURIComponent(projectMatch[1]!));
        if (!project) {
          json(res, 404, { error: 'Project not found.' });
          return true;
        }
        json(res, 200, project);
        return true;
      }
      const projectFiles = pathname.match(/^\/api\/projects\/([^/]+)\/files$/);
      if (req.method === 'GET' && projectFiles) {
        const projectId = decodeURIComponent(projectFiles[1]!);
        const project = await requireProjects(options).get(actor, projectId);
        if (!project) {
          json(res, 404, { error: 'Project not found.' });
          return true;
        }
        const files = await requireFiles(options).list(actor, projectId);
        const presented = await Promise.all(
          files.map(async (file) => publicFile(file, await requireFiles(options).originFor(actor, file))),
        );
        json(res, 200, presented);
        return true;
      }
      if (req.method === 'POST' && projectFiles) {
        const projectId = decodeURIComponent(projectFiles[1]!);
        const project = await requireProjects(options).get(actor, projectId);
        if (!project) {
          json(res, 404, { error: 'Project not found.' });
          return true;
        }
        const uploaded = await readUpload(req, options);
        const file = await requireFiles(options).ingest(actor, {
          projectId,
          path: uploaded.path,
          bytes: uploaded.bytes,
          declaredMime: uploaded.mime,
        });
        try {
          for (let i = 0; i < 4; i += 1) {
            const outcome = await requireFiles(options).processNextJob(actor, `workbench:${actor.principalId}`);
            if (!outcome) break;
          }
        } catch {
          // Ingest is durable even if extraction is still pending.
        }
        const latest = (await requireFiles(options).getMetadata(actor, file.id)) ?? file;
        json(res, 201, publicFile(latest, await requireFiles(options).originFor(actor, latest)));
        return true;
      }
      const projectConversations = pathname.match(/^\/api\/projects\/([^/]+)\/conversations$/);
      if (req.method === 'GET' && projectConversations) {
        const projectId = decodeURIComponent(projectConversations[1]!);
        const project = await requireProjects(options).get(actor, projectId);
        if (!project) {
          json(res, 404, { error: 'Project not found.' });
          return true;
        }
        if (!sessionOwnsHostConversations(actor, options)) {
          json(res, 200, []);
          return true;
        }
        const conversations = visibleHostConversations(
          (await options.runtime.listConversations()).filter(
            (item) => item.projectId === projectId || item.workspaceId === projectId,
          ),
        );
        json(res, 200, conversations);
        return true;
      }
      if (req.method === 'POST' && projectConversations) {
        const projectId = decodeURIComponent(projectConversations[1]!);
        const project = await requireProjects(options).get(actor, projectId);
        if (!project) {
          json(res, 404, { error: 'Project not found.' });
          return true;
        }
        if (!sessionOwnsHostConversations(actor, options)) {
          json(res, 404, { error: 'Permission denied.' });
          return true;
        }
        const body = await readJson(req, options.maxRequestBytes);
        const conversation = await options.runtime.createConversation({
          title: typeof body.title === 'string' ? body.title : undefined,
          projectId,
        });
        json(res, 201, conversation);
        return true;
      }
      const projectContext = pathname.match(/^\/api\/projects\/([^/]+)\/context$/);
      if (req.method === 'GET' && projectContext) {
        const projectId = decodeURIComponent(projectContext[1]!);
        const project = await requireProjects(options).get(actor, projectId);
        if (!project) {
          json(res, 404, { error: 'Project not found.' });
          return true;
        }
        const assembled = await requireContext(options).assemble(actor, {
          projectId,
          query: query.get('query') ?? '',
          tokenBudget: Number(query.get('tokenBudget') ?? 2000) || 2000,
          conversationId: query.get('conversationId') ?? undefined,
        });
        json(res, 200, assembled);
        return true;
      }
      const fileMatch = pathname.match(/^\/api\/files\/([^/]+)$/);
      if (req.method === 'GET' && fileMatch) {
        const file = await requireFiles(options).getMetadata(actor, decodeURIComponent(fileMatch[1]!));
        if (!file) {
          json(res, 404, { error: 'File not found.' });
          return true;
        }
        json(res, 200, publicFile(file, await requireFiles(options).originFor(actor, file)));
        return true;
      }
      const fileContent = pathname.match(/^\/api\/files\/([^/]+)\/content$/);
      if (req.method === 'GET' && fileContent) {
        const fileId = decodeURIComponent(fileContent[1]!);
        const file = await requireFiles(options).getMetadata(actor, fileId);
        if (!file) {
          json(res, 404, { error: 'File not found.' });
          return true;
        }
        const bytes = await requireFiles(options).readBytes(actor, fileId);
        sendBytes(req, res, bytes, file.mimeType || 'application/octet-stream');
        return true;
      }
      const attachMatch = pathname.match(/^\/api\/files\/([^/]+)\/attach$/);
      if (req.method === 'POST' && attachMatch) {
        const body = await readJson(req, options.maxRequestBytes);
        const conversationId = typeof body.conversationId === 'string' ? body.conversationId : '';
        if (!conversationId) {
          json(res, 400, { error: 'conversationId is required.' });
          return true;
        }
        const attachment = await requireFiles(options).attachToConversation(actor, {
          conversationId,
          fileId: decodeURIComponent(attachMatch[1]!),
          messageId: typeof body.messageId === 'string' ? body.messageId : null,
        });
        json(res, 200, attachment);
        return true;
      }
      if (req.method === 'GET' && pathname === '/api/approvals') {
        json(res, 200, await requireTools(options).listAwaiting(actor));
        return true;
      }
      json(res, 404, { error: 'Not found.' });
      return true;
    } catch (err) {
      return handleWorkbenchError(res, err);
    }
  }

  const conversationExtras = pathname.match(/^\/api\/conversations\/([^/]+)\/(tools|attachments|context)$/);
  if (conversationExtras) {
    const actor = await resolveActor(req, options);
    if (!actor) {
      json(res, 401, { error: 'Authentication required.' });
      return true;
    }
    const conversationId = decodeURIComponent(conversationExtras[1]!);
    if (!sessionOwnsHostConversations(actor, options)) {
      json(res, 404, { error: 'Conversation not found.' });
      return true;
    }
    const snapshot = await options.runtime.getSnapshot(conversationId);
    if (!snapshot) {
      json(res, 404, { error: 'Conversation not found.' });
      return true;
    }
    try {
      if (conversationExtras[2] === 'tools' && req.method === 'GET') {
        json(res, 200, await requireTools(options).listByConversation(actor, conversationId));
        return true;
      }
      if (conversationExtras[2] === 'attachments' && req.method === 'GET') {
        json(res, 200, await requireFiles(options).listAttachments(actor, conversationId));
        return true;
      }
      if (conversationExtras[2] === 'context' && req.method === 'GET') {
        const projectId = snapshot.conversation.projectId ?? snapshot.conversation.workspaceId;
        if (!projectId) {
          json(res, 200, { slices: [], citations: [], truncated: false, tokenCount: 0, tokenBudget: 0 });
          return true;
        }
        json(
          res,
          200,
          await requireContext(options).assemble(actor, {
            projectId,
            query: query.get('query') ?? snapshot.conversation.title,
            tokenBudget: Number(query.get('tokenBudget') ?? 2000) || 2000,
            conversationId,
          }),
        );
        return true;
      }
    } catch (err) {
      return handleWorkbenchError(res, err);
    }
  }

  const executionMatch = pathname.match(/^\/api\/executions\/([^/]+)$/);
  if (req.method === 'GET' && executionMatch) {
    const actor = await resolveActor(req, options);
    if (!actor) {
      json(res, 401, { error: 'Authentication required.' });
      return true;
    }
    if (!sessionOwnsHostConversations(actor, options)) {
      json(res, 404, { error: 'Execution not found.' });
      return true;
    }
    const execution = await options.runtime.getExecution(decodeURIComponent(executionMatch[1]!));
    if (!execution) {
      json(res, 404, { error: 'Execution not found.' });
      return true;
    }
    const snapshot = await options.runtime.getSnapshot(execution.conversationId);
    if (!snapshot) {
      json(res, 404, { error: 'Execution not found.' });
      return true;
    }
    const tools = options.tools ? await options.tools.listByConversation(actor, execution.conversationId) : [];
    json(res, 200, {
      execution: inspectExecution(execution),
      conversationId: execution.conversationId,
      tools: tools.filter((item) => item.executionId === execution.id),
    });
    return true;
  }

  return false;
}

function inspectExecution(execution: {
  id: string;
  status: string;
  capability: string;
  selectedProvider: string | null;
  selectedModel: string | null;
  attempts: Array<{
    index: number;
    provider: string;
    model: string;
    outcome: string;
    emittedVisibleOutput: boolean;
    error: { code: string; message: string } | null;
  }>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  failureReason: { code: string; message: string; retryable?: boolean } | null;
  route: {
    target: string;
    resolvedRouteId: string;
    decisionReason: string;
    provider?: string;
    model?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}) {
  const visibleBegun = execution.attempts.some((attempt) => attempt.emittedVisibleOutput);
  return {
    id: execution.id,
    status: execution.status,
    capability: execution.capability,
    selectedProvider: execution.selectedProvider,
    selectedModel: execution.selectedModel,
    route: execution.route
      ? {
          target: execution.route.target,
          resolvedRouteId: execution.route.resolvedRouteId,
          decisionReason: execution.route.decisionReason,
          provider: execution.route.provider ?? execution.selectedProvider,
          model: execution.route.model ?? execution.selectedModel,
        }
      : null,
    attempts: execution.attempts.map((attempt) => ({
      index: attempt.index,
      provider: attempt.provider,
      model: attempt.model,
      outcome: attempt.outcome,
      emittedVisibleOutput: attempt.emittedVisibleOutput,
      error: attempt.error,
    })),
    usage: execution.usage,
    failureReason: execution.failureReason,
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    visibleOutputBegun: visibleBegun,
    providerSwitchDisguised: disguisedProviderSwitch(execution.attempts),
  };
}

function disguisedProviderSwitch(
  attempts: Array<{ provider: string; emittedVisibleOutput: boolean }>,
): boolean {
  let visibleProvider: string | null = null;
  for (const attempt of attempts) {
    if (attempt.emittedVisibleOutput) {
      if (visibleProvider && visibleProvider !== attempt.provider) return true;
      visibleProvider = attempt.provider;
      continue;
    }
    if (visibleProvider && attempt.provider !== visibleProvider) return true;
  }
  return false;
}

async function handleGetSession(req: IncomingMessage, res: ServerResponse, options: WorkbenchHostOptions): Promise<void> {
  if (!options.auth) {
    json(res, 200, {
      authenticated: Boolean(options.tenantId && options.principalId),
      bootstrapAllowed: !options.production,
      loginAvailable: Boolean(options.login),
      principal: options.principalId
        ? { id: options.principalId, tenantBound: Boolean(options.tenantId) }
        : null,
      csrfToken: null,
    });
    return;
  }
  const cookie = options.auth.parseCookie(header(req, 'cookie'));
  if (!cookie) {
    json(res, 200, {
      authenticated: false,
      bootstrapAllowed: !options.production,
      loginAvailable: Boolean(options.login),
      principal: null,
      csrfToken: null,
    });
    return;
  }
  try {
    const resolved = await options.auth.resolve({
      sessionId: cookie,
      csrfToken: header(req, options.auth.csrfHeader),
      origin: header(req, 'origin'),
      mutating: false,
    });
    json(res, 200, {
      authenticated: true,
      bootstrapAllowed: false,
      loginAvailable: Boolean(options.login),
      principal: {
        id: resolved.actor.principalId,
        kind: resolved.actor.kind,
        tenantBound: Boolean(resolved.actor.tenantId),
      },
      csrfToken: resolved.csrfToken ?? null,
    });
  } catch (err) {
    if (err instanceof SessionRevokedError || (err instanceof AuthenticationError && err.code === 'unauthenticated')) {
      expireSessionCookie(res, options);
      json(res, 200, {
        authenticated: false,
        bootstrapAllowed: !options.production,
        loginAvailable: Boolean(options.login),
        principal: null,
        csrfToken: null,
      });
      return;
    }
    throw err;
  }
}

async function handleNativeLogin(req: IncomingMessage, res: ServerResponse, options: WorkbenchHostOptions): Promise<void> {
  if (!options.login || !options.auth) {
    json(res, 503, { error: 'Native login is unavailable.' });
    return;
  }
  const body = await readJson(req, options.maxRequestBytes);
  const login = typeof body.login === 'string' ? body.login : typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';
  try {
    const issued = await options.login.authenticate({
      login,
      password,
      origin: header(req, 'origin'),
      userAgent: header(req, 'user-agent'),
      sourceKey: loginSourceKey(req),
      claimedTenantId:
        (typeof body.tenantId === 'string' && body.tenantId) ||
        (typeof body.tenant === 'string' && body.tenant) ||
        header(req, 'x-atlas-tenant') ||
        urlQuery(req).get('tenant'),
    });
    res.setHeader('Set-Cookie', options.auth.cookieHeader(issued.sessionId, options.production === true));
    json(res, 200, {
      authenticated: true,
      bootstrapAllowed: false,
      loginAvailable: true,
      csrfToken: issued.csrfToken,
      principal: { id: issued.principalId, kind: 'user', tenantBound: true },
    });
  } catch (err) {
    if (err instanceof RateLimitedError) {
      res.setHeader('Retry-After', '300');
      json(res, 429, { error: 'Too many login attempts. Try again later.' });
      return;
    }
    if (err instanceof OriginError) {
      json(res, 403, { error: 'Origin validation failed.' });
      return;
    }
    if (err instanceof AuthenticationError && err.code === 'unauthenticated') {
      json(res, 401, { error: 'Invalid credentials.' });
      return;
    }
    throw err;
  }
}

function loginSourceKey(req: IncomingMessage): string {
  const ip = loginClientAddress({
    remoteAddress: req.socket?.remoteAddress,
    forwardedFor: header(req, 'x-forwarded-for'),
  });
  return ip ? `ip:${ip}` : 'ip:unknown';
}

async function handleIssueSession(req: IncomingMessage, res: ServerResponse, options: WorkbenchHostOptions): Promise<void> {
  if (options.production) {
    json(res, 401, { error: 'Authentication required.' });
    return;
  }
  if (!options.auth || !options.tenantId || !options.principalId) {
    json(res, 503, { error: 'Session bootstrap is unavailable.' });
    return;
  }
  const body = await readJson(req, options.maxRequestBytes);
  if (typeof body.tenantId === 'string' && body.tenantId && body.tenantId !== options.tenantId) {
    json(res, 403, { error: 'Fail-closed: caller tenant id is not membership.' });
    return;
  }
  const issued = await options.auth.issueSession({
    principalId: options.principalId,
    tenantId: options.tenantId,
  });
  res.setHeader('Set-Cookie', options.auth.cookieHeader(issued.session.id));
  json(res, 201, {
    authenticated: true,
    csrfToken: issued.csrfToken,
    principal: { id: options.principalId, kind: 'user', tenantBound: true },
  });
}

async function handleRevokeSession(req: IncomingMessage, res: ServerResponse, options: WorkbenchHostOptions): Promise<void> {
  if (!options.auth) {
    json(res, 200, { revoked: false });
    return;
  }
  const cookie = options.auth.parseCookie(header(req, 'cookie'));
  if (!cookie) {
    json(res, 200, { revoked: false });
    return;
  }
  try {
    await options.auth.revoke(cookie);
  } catch (err) {
    if (!(err instanceof SessionRevokedError) && !(err instanceof AuthenticationError && err.code === 'unauthenticated')) {
      throw err;
    }
  }
  expireSessionCookie(res, options);
  json(res, 200, { revoked: true });
}

async function readUpload(
  req: IncomingMessage,
  options: WorkbenchHostOptions,
): Promise<{ path: string; bytes: Uint8Array; mime?: string }> {
  const maxBytes = options.maxUploadBytes ?? DEFAULT_OPERATIONAL_LIMITS.maxUploadBytes;
  const contentType = header(req, 'content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const boundary = contentType.split('boundary=')[1]?.trim();
    if (!boundary) throw new Error('Multipart boundary missing.');
    return parseMultipart(await readRaw(req, maxBytes), boundary);
  }
  const body = JSON.parse((await readRaw(req, maxBytes)).toString('utf8') || '{}') as Record<string, unknown>;
  const path = typeof body.path === 'string' ? body.path : '';
  if (!path) throw new Error('File path is required.');
  if (typeof body.text === 'string') {
    return {
      path,
      bytes: new TextEncoder().encode(body.text),
      mime: typeof body.mime === 'string' ? body.mime : undefined,
    };
  }
  if (typeof body.contentBase64 === 'string') {
    return {
      path,
      bytes: Buffer.from(body.contentBase64, 'base64'),
      mime: typeof body.mime === 'string' ? body.mime : undefined,
    };
  }
  throw new Error('File text or contentBase64 is required.');
}

function parseMultipart(buffer: Buffer, boundary: string): { path: string; bytes: Uint8Array; mime?: string } {
  const delim = `--${boundary}`;
  const parts = buffer.toString('latin1').split(delim);
  let path = '';
  let bytes: Uint8Array | null = null;
  let mime: string | undefined;
  for (const part of parts) {
    if (!part.includes('\r\n\r\n')) continue;
    const [rawHeaders, ...rest] = part.split('\r\n\r\n');
    const body = rest.join('\r\n\r\n').replace(/\r\n--$/, '').replace(/^\r\n/, '').replace(/\r\n$/, '');
    const disposition = rawHeaders ?? '';
    const name = /name="([^"]+)"/.exec(disposition)?.[1];
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1];
    const partMime = /Content-Type:\s*([^\r\n]+)/i.exec(disposition)?.[1]?.trim();
    if (name === 'path') path = Buffer.from(body, 'latin1').toString('utf8').trim();
    if (name === 'file' || filename) {
      bytes = Buffer.from(body, 'latin1');
      path = path || filename || 'upload.bin';
      mime = partMime;
    }
  }
  if (!path || !bytes) throw new Error('Multipart upload requires path and file.');
  return { path, bytes, mime };
}

function requireProjects(options: WorkbenchHostOptions): ProjectService {
  if (!options.projects) throw new WorkbenchUnavailableError('projects_unavailable', 'Projects require platform persistence.');
  return options.projects;
}

function requireFiles(options: WorkbenchHostOptions): FilesService {
  if (!options.files) throw new WorkbenchUnavailableError('files_unavailable', 'Files require platform persistence and CAS.');
  return options.files;
}

function requireContext(options: WorkbenchHostOptions): ContextService {
  if (!options.context) throw new WorkbenchUnavailableError('context_unavailable', 'Context requires platform persistence.');
  return options.context;
}

function requireTools(options: WorkbenchHostOptions): ToolEngine {
  if (!options.tools) throw new WorkbenchUnavailableError('tools_unavailable', 'Tools are not configured.');
  return options.tools;
}

class WorkbenchUnavailableError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkbenchUnavailableError';
  }
}

function handleWorkbenchError(res: ServerResponse, err: unknown): true {
  if (err instanceof WorkbenchUnavailableError) {
    json(res, 503, { error: err.message, code: err.code });
    return true;
  }
  if (err instanceof AuthenticationError) {
    json(res, err.code === 'unauthenticated' ? 401 : 403, { error: err.message });
    return true;
  }
  if (err instanceof OwnershipError || err instanceof FilesAccessError) {
    json(res, 404, { error: 'Permission denied.' });
    return true;
  }
  if (err instanceof CasMissingError) {
    json(res, 503, { error: 'CAS object missing.', code: 'cas_unavailable' });
    return true;
  }
  if (err instanceof PersistenceUnavailableError || err instanceof PersistenceClosedError || isPersistenceConnectionLoss(err)) {
    json(res, 503, { error: 'Persistence unavailable.', code: 'persistence_unavailable' });
    return true;
  }
  if (err instanceof PathSafetyError || err instanceof UnsupportedMediaError) {
    json(res, 400, { error: err.message });
    return true;
  }
  if (err instanceof ToolError) {
    const status = err.code === 'permission_denied' || err.message === 'Permission denied.' ? 404 : 400;
    json(res, status, { error: err.message });
    return true;
  }
  if (err instanceof SyntaxError) {
    json(res, 400, { error: 'Malformed JSON.' });
    return true;
  }
  throw err;
}

export type { ConversationRuntime, AuthService, PlatformPersistence };
