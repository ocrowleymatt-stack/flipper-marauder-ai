import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DungeonId } from '@atlas-vnext/contracts';
import { AuthenticationError } from '@atlas-vnext/auth';
import { DungeonError, OsintService } from '@atlas-vnext/dungeon-osint';
import { InvestigationError, InvestigationService } from '@atlas-vnext/dungeon-investigation';
import { ResearchError, ResearchService } from '@atlas-vnext/dungeon-research';
import { WebsiteError, WebsiteStudioService } from '@atlas-vnext/dungeon-website';
import { MusicError, MusicService } from '@atlas-vnext/dungeon-music';
import { PrivacyError, PrivacyService } from '@atlas-vnext/dungeon-privacy';
import { json, readJson, urlPath } from './http.ts';
import { resolveActor, type WorkbenchHostOptions } from './workbench.ts';

export interface EstateHostOptions extends WorkbenchHostOptions {
  osint?: OsintService | null;
  investigation?: InvestigationService | null;
  research?: ResearchService | null;
  websiteStudio?: WebsiteStudioService | null;
  music?: MusicService | null;
  privacy?: PrivacyService | null;
}

export async function handleEstate(
  req: IncomingMessage,
  res: ServerResponse,
  options: EstateHostOptions,
): Promise<boolean> {
  const pathname = urlPath(req);
  if (!isEstatePath(pathname)) return false;
  try {
    const actor = await resolveActor(req, options);
    if (await handleOsint(req, res, options, pathname, actor)) return true;
    if (await handleInvestigation(req, res, options, pathname, actor)) return true;
    if (await handleResearch(req, res, options, pathname, actor)) return true;
    if (await handleWebsite(req, res, options, pathname, actor)) return true;
    if (await handleMusic(req, res, options, pathname, actor)) return true;
    if (await handlePrivacy(req, res, options, pathname, actor)) return true;
    return false;
  } catch (err) {
    return writeEstateError(res, err);
  }
}

function isEstatePath(pathname: string): boolean {
  return (
    pathname.startsWith('/api/privacy') ||
    pathname.startsWith('/api/osint/') ||
    pathname.startsWith('/api/cases/') ||
    pathname.startsWith('/api/research/') ||
    pathname.startsWith('/api/sites/') ||
    pathname.startsWith('/api/compositions/') ||
    /\/api\/projects\/[^/]+\/(osint|cases|research|sites|compositions)(\/|$)/.test(pathname)
  );
}

function requireActor(actor: Awaited<ReturnType<typeof resolveActor>>) {
  if (!actor) {
    const err = new AuthenticationError('unauthenticated', 'Authentication required.');
    throw err;
  }
  return actor;
}

async function handleOsint(
  req: IncomingMessage,
  res: ServerResponse,
  options: EstateHostOptions,
  pathname: string,
  actor: Awaited<ReturnType<typeof resolveActor>>,
): Promise<boolean> {
  const projectTargets = pathname.match(/^\/api\/projects\/([^/]+)\/osint\/targets$/);
  const projectScans = pathname.match(/^\/api\/projects\/([^/]+)\/osint\/scans$/);
  const item = pathname.match(/^\/api\/osint\/([^/]+)$/);
  const findings = pathname.match(/^\/api\/osint\/([^/]+)\/findings$/);
  if (!projectTargets && !projectScans && !item && !findings) return false;
  const resolved = requireActor(actor);
  const osint = requireService(options.osint, 'osint');
  const writingActor = { tenantId: resolved.tenantId, principalId: resolved.principalId };
  if (req.method === 'GET' && projectTargets) {
    json(res, 200, await osint.listTargets(writingActor, decodeURIComponent(projectTargets[1]!)));
    return true;
  }
  if (req.method === 'POST' && projectScans) {
    const body = await readJson(req, options.maxRequestBytes);
    json(
      res,
      201,
      await osint.scan(writingActor, {
        projectId: decodeURIComponent(projectScans[1]!),
        kind: body.kind === 'email' || body.kind === 'username' || body.kind === 'ip' || body.kind === 'person' || body.kind === 'organisation' ? body.kind : 'domain',
        value: typeof body.value === 'string' ? body.value : '',
        synthesize: body.synthesize !== false,
      }),
    );
    return true;
  }
  if (req.method === 'GET' && findings) {
    json(res, 200, await osint.listFindings(writingActor, decodeURIComponent(findings[1]!)));
    return true;
  }
  if (req.method === 'GET' && item) {
    json(res, 200, await osint.get(writingActor, decodeURIComponent(item[1]!)));
    return true;
  }
  json(res, 404, { error: 'Not found.' });
  return true;
}

async function handleInvestigation(
  req: IncomingMessage,
  res: ServerResponse,
  options: EstateHostOptions,
  pathname: string,
  actor: Awaited<ReturnType<typeof resolveActor>>,
): Promise<boolean> {
  const list = pathname.match(/^\/api\/projects\/([^/]+)\/cases$/);
  const item = pathname.match(/^\/api\/cases\/([^/]+)$/);
  const challenge = pathname.match(/^\/api\/cases\/([^/]+)\/challenge$/);
  if (!list && !item && !challenge) return false;
  const resolved = requireActor(actor);
  const service = requireService(options.investigation, 'investigation');
  const writingActor = { tenantId: resolved.tenantId, principalId: resolved.principalId };
  if (req.method === 'GET' && list) {
    json(res, 200, await service.listCases(writingActor, decodeURIComponent(list[1]!)));
    return true;
  }
  if (req.method === 'POST' && list) {
    const body = await readJson(req, options.maxRequestBytes);
    json(
      res,
      201,
      await service.createCase(writingActor, {
        projectId: decodeURIComponent(list[1]!),
        title: typeof body.title === 'string' ? body.title : 'Case',
        question: typeof body.question === 'string' ? body.question : '',
        findingIds: Array.isArray(body.findingIds) ? body.findingIds.map(String) : [],
      }),
    );
    return true;
  }
  if (req.method === 'GET' && item) {
    json(res, 200, await service.get(writingActor, decodeURIComponent(item[1]!)));
    return true;
  }
  if (req.method === 'POST' && challenge) {
    const body = await readJson(req, options.maxRequestBytes);
    const stance = body.stance === 'advocate' || body.stance === 'arbiter' ? body.stance : 'challenger';
    json(res, 201, await service.challenge(writingActor, decodeURIComponent(challenge[1]!), stance));
    return true;
  }
  json(res, 404, { error: 'Not found.' });
  return true;
}

async function handleResearch(
  req: IncomingMessage,
  res: ServerResponse,
  options: EstateHostOptions,
  pathname: string,
  actor: Awaited<ReturnType<typeof resolveActor>>,
): Promise<boolean> {
  const list = pathname.match(/^\/api\/projects\/([^/]+)\/research$/);
  const item = pathname.match(/^\/api\/research\/([^/]+)$/);
  const run = pathname.match(/^\/api\/research\/([^/]+)\/run$/);
  if (!list && !item && !run) return false;
  const resolved = requireActor(actor);
  const service = requireService(options.research, 'research');
  const writingActor = { tenantId: resolved.tenantId, principalId: resolved.principalId };
  if (req.method === 'GET' && list) {
    json(res, 200, await service.list(writingActor, decodeURIComponent(list[1]!)));
    return true;
  }
  if (req.method === 'POST' && list) {
    const body = await readJson(req, options.maxRequestBytes);
    json(
      res,
      201,
      await service.create(writingActor, {
        projectId: decodeURIComponent(list[1]!),
        question: typeof body.question === 'string' ? body.question : '',
        fileIds: Array.isArray(body.fileIds) ? body.fileIds.map(String) : [],
      }),
    );
    return true;
  }
  if (req.method === 'GET' && item) {
    json(res, 200, await service.get(writingActor, decodeURIComponent(item[1]!)));
    return true;
  }
  if (req.method === 'POST' && run) {
    json(res, 200, await service.run(writingActor, decodeURIComponent(run[1]!)));
    return true;
  }
  json(res, 404, { error: 'Not found.' });
  return true;
}

async function handleWebsite(
  req: IncomingMessage,
  res: ServerResponse,
  options: EstateHostOptions,
  pathname: string,
  actor: Awaited<ReturnType<typeof resolveActor>>,
): Promise<boolean> {
  const list = pathname.match(/^\/api\/projects\/([^/]+)\/sites$/);
  const item = pathname.match(/^\/api\/sites\/([^/]+)$/);
  const generate = pathname.match(/^\/api\/sites\/([^/]+)\/generate$/);
  const preview = pathname.match(/^\/api\/sites\/([^/]+)\/preview$/);
  const promote = pathname.match(/^\/api\/sites\/([^/]+)\/promote$/);
  if (!list && !item && !generate && !preview && !promote) return false;
  const resolved = requireActor(actor);
  const service = requireService(options.websiteStudio, 'website');
  const writingActor = { tenantId: resolved.tenantId, principalId: resolved.principalId };
  if (req.method === 'GET' && list) {
    json(res, 200, await service.list(writingActor, decodeURIComponent(list[1]!)));
    return true;
  }
  if (req.method === 'POST' && list) {
    const body = await readJson(req, options.maxRequestBytes);
    json(
      res,
      201,
      await service.create(writingActor, {
        projectId: decodeURIComponent(list[1]!),
        name: typeof body.name === 'string' ? body.name : 'Site',
        brief: typeof body.brief === 'string' ? body.brief : '',
      }),
    );
    return true;
  }
  if (req.method === 'GET' && item) {
    json(res, 200, await service.get(writingActor, decodeURIComponent(item[1]!)));
    return true;
  }
  if (req.method === 'POST' && generate) {
    const body = await readJson(req, options.maxRequestBytes);
    json(res, 200, await service.generate(writingActor, decodeURIComponent(generate[1]!), typeof body.brief === 'string' ? body.brief : ''));
    return true;
  }
  if (req.method === 'GET' && preview) {
    const previewBody = await service.preview(writingActor, decodeURIComponent(preview[1]!));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Atlas-Concern': 'preview_deployment' });
    res.end(previewBody.html);
    return true;
  }
  if (req.method === 'POST' && promote) {
    json(res, 200, await service.promote(writingActor, decodeURIComponent(promote[1]!)));
    return true;
  }
  json(res, 404, { error: 'Not found.' });
  return true;
}

async function handleMusic(
  req: IncomingMessage,
  res: ServerResponse,
  options: EstateHostOptions,
  pathname: string,
  actor: Awaited<ReturnType<typeof resolveActor>>,
): Promise<boolean> {
  const list = pathname.match(/^\/api\/projects\/([^/]+)\/compositions$/);
  const item = pathname.match(/^\/api\/compositions\/([^/]+)$/);
  const compose = pathname.match(/^\/api\/compositions\/([^/]+)\/compose$/);
  if (!list && !item && !compose) return false;
  const resolved = requireActor(actor);
  const service = requireService(options.music, 'music');
  const writingActor = { tenantId: resolved.tenantId, principalId: resolved.principalId };
  if (req.method === 'GET' && list) {
    json(res, 200, await service.list(writingActor, decodeURIComponent(list[1]!)));
    return true;
  }
  if (req.method === 'POST' && list) {
    const body = await readJson(req, options.maxRequestBytes);
    json(
      res,
      201,
      await service.create(writingActor, {
        projectId: decodeURIComponent(list[1]!),
        title: typeof body.title === 'string' ? body.title : 'Composition',
        brief: typeof body.brief === 'string' ? body.brief : '',
      }),
    );
    return true;
  }
  if (req.method === 'GET' && item) {
    json(res, 200, await service.get(writingActor, decodeURIComponent(item[1]!)));
    return true;
  }
  if (req.method === 'POST' && compose) {
    json(res, 200, await service.compose(writingActor, decodeURIComponent(compose[1]!)));
    return true;
  }
  json(res, 404, { error: 'Not found.' });
  return true;
}

async function handlePrivacy(
  req: IncomingMessage,
  res: ServerResponse,
  options: EstateHostOptions,
  pathname: string,
  actor: Awaited<ReturnType<typeof resolveActor>>,
): Promise<boolean> {
  if (!pathname.startsWith('/api/privacy')) return false;
  const resolved = requireActor(actor);
  const service = requireService(options.privacy, 'privacy');
  const writingActor = { tenantId: resolved.tenantId, principalId: resolved.principalId, kind: 'user' as const };
  if (req.method === 'GET' && pathname === '/api/privacy/effective') {
    const dungeon = privacyDungeonQuery(req);
    json(res, 200, await service.effective(writingActor, dungeon));
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/privacy/explain') {
    const body = await readJson(req, options.maxRequestBytes);
    json(
      res,
      200,
      await service.explain(writingActor, {
        action: typeof body.action === 'string' ? body.action : 'inspect',
        capability: typeof body.capability === 'string' ? body.capability : 'artifact.read',
        dungeonId: asDungeon(body.dungeonId),
      }),
    );
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/privacy/policy') {
    const body = await readJson(req, options.maxRequestBytes);
    json(
      res,
      200,
      await service.update(writingActor, {
        dungeonId: asDungeon(body.dungeonId),
        patch: typeof body.patch === 'object' && body.patch ? (body.patch as Record<string, unknown>) : {},
        expectedRevision: Number.isFinite(Number(body.expectedRevision)) ? Number(body.expectedRevision) : undefined,
        confirm: typeof body.confirm === 'string' ? body.confirm : undefined,
        proposedByModel: body.proposedByModel === true,
      }),
    );
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/privacy/audit') {
    json(res, 200, await service.audit(writingActor));
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/privacy/proposals') {
    json(res, 200, await service.listProposals(writingActor));
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/privacy/proposals') {
    const body = await readJson(req, options.maxRequestBytes);
    json(
      res,
      201,
      await service.propose(writingActor, {
        dungeonId: asDungeon(body.dungeonId),
        patch: typeof body.patch === 'object' && body.patch ? (body.patch as Record<string, unknown>) : {},
      }),
    );
    return true;
  }
  const decide = pathname.match(/^\/api\/privacy\/proposals\/([^/]+)\/decide$/);
  if (req.method === 'POST' && decide) {
    const body = await readJson(req, options.maxRequestBytes);
    json(
      res,
      200,
      await service.decideProposal(writingActor, decodeURIComponent(decide[1]!), body.status === 'denied' ? 'denied' : 'approved'),
    );
    return true;
  }
  json(res, 404, { error: 'Not found.' });
  return true;
}

function requireService<T>(service: T | null | undefined, name: string): T {
  if (!service) {
    const err = new DungeonError(`${name}_unavailable`, `${name} requires platform persistence.`, 503);
    throw err;
  }
  return service;
}

function writeEstateError(res: ServerResponse, err: unknown): true {
  if (
    err instanceof DungeonError ||
    err instanceof InvestigationError ||
    err instanceof ResearchError ||
    err instanceof WebsiteError ||
    err instanceof MusicError ||
    err instanceof PrivacyError
  ) {
    json(res, err.httpStatus, { error: err.message, code: err.code });
    return true;
  }
  if (err instanceof AuthenticationError) {
    json(res, err.code === 'unauthenticated' ? 401 : 403, { error: err.message });
    return true;
  }
  throw err;
}

function privacyDungeonQuery(req: IncomingMessage): DungeonId | null {
  const value = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('dungeon');
  return asDungeon(value);
}

function asDungeon(value: unknown): DungeonId | null {
  const allowed: DungeonId[] = ['writing', 'investigation', 'research', 'website', 'osint', 'music', 'privacy'];
  return typeof value === 'string' && allowed.includes(value as DungeonId) ? (value as DungeonId) : null;
}
