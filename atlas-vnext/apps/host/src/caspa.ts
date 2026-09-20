import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuthenticationError } from '@atlas-vnext/auth';
import { WritingError, WritingService, type WritingActor } from '@atlas-vnext/dungeon-writing';
import { DEFAULT_OPERATIONAL_LIMITS, writingOperationSchema, type DungeonRegistration } from '@atlas-vnext/contracts';
import { CasMissingError, FilesAccessError } from '@atlas-vnext/files';
import { ConflictError, OwnershipError, PersistenceClosedError, PersistenceUnavailableError, isPersistenceConnectionLoss } from '@atlas-vnext/persistence';
import { AuthorityDeniedError } from '@atlas-vnext/permissions';
import { PlatformHttpError } from './errors.ts';
import { header, isMutating, json, matchingOrigin, readJson, sseHeaders, urlPath, writeSse } from './http.ts';
import { normalizeContextFileIds, type ResourceGuard } from './limits.ts';
import type { TimeoutContract } from './production-config.ts';
import { acquireRunAndStreamPermits, pipeSse } from './sse.ts';
import { resolveActor, type WorkbenchHostOptions } from './workbench.ts';
import { dungeonCatalogue } from './dungeon-catalogue.ts';

export interface CaspaHostOptions extends WorkbenchHostOptions {
  writing?: WritingService | null;
  resources?: ResourceGuard;
  timeouts?: TimeoutContract;
  allowedOrigins?: string[];
  dungeons?: DungeonRegistration[];
}

export async function handleCaspa(
  req: IncomingMessage,
  res: ServerResponse,
  options: CaspaHostOptions,
): Promise<boolean> {
  const pathname = urlPath(req);

  if (req.method === 'GET' && pathname === '/api/dungeons') {
    const actor = await resolveActor(req, options);
    if (!actor) {
      json(res, 401, { error: 'Authentication required.' });
      return true;
    }
    json(res, 200, dungeonCatalogue(options.dungeons));
    return true;
  }

  const projectDocs = pathname.match(/^\/api\/projects\/([^/]+)\/documents$/);
  const documentMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
  const generateMatch = pathname.match(/^\/api\/documents\/([^/]+)\/generate$/);
  const versionsMatch = pathname.match(/^\/api\/documents\/([^/]+)\/versions$/);
  const restoreMatch = pathname.match(/^\/api\/documents\/([^/]+)\/restore$/);
  const provenanceMatch = pathname.match(/^\/api\/documents\/([^/]+)\/provenance$/);
  const cancelMatch = pathname.match(/^\/api\/documents\/([^/]+)\/cancel$/);
  const editMatch = pathname.match(/^\/api\/documents\/([^/]+)\/edit$/);
  const companionsMatch = pathname.match(/^\/api\/documents\/([^/]+)\/companions$/);
  const commissionMatch = pathname.match(/^\/api\/documents\/([^/]+)\/commission$/);
  const storyBibleMatch = pathname.match(/^\/api\/projects\/([^/]+)\/story-bible$/);
  const structureMatch = pathname.match(/^\/api\/documents\/([^/]+)\/structure$/);
  const qualityMatch = pathname.match(/^\/api\/documents\/([^/]+)\/quality$/);

  if (
    !projectDocs &&
    !documentMatch &&
    !generateMatch &&
    !versionsMatch &&
    !restoreMatch &&
    !provenanceMatch &&
    !cancelMatch &&
    !editMatch &&
    !companionsMatch &&
    !commissionMatch &&
    !storyBibleMatch &&
    !structureMatch &&
    !qualityMatch
  ) {
    return false;
  }

  const actor = await resolveActor(req, options);
  if (!actor) {
    json(res, 401, { error: 'Authentication required.' });
    return true;
  }
  const writingActor: WritingActor = { tenantId: actor.tenantId, principalId: actor.principalId };

  try {
    const writing = requireWriting(options);
    if (req.method === 'GET' && projectDocs) {
      json(res, 200, await writing.list(writingActor, decodeURIComponent(projectDocs[1]!)));
      return true;
    }
    if (req.method === 'POST' && projectDocs) {
      const body = await readJson(req, options.maxRequestBytes);
      const document = await writing.create(writingActor, {
        projectId: decodeURIComponent(projectDocs[1]!),
        title: typeof body.title === 'string' ? body.title : undefined,
        instruction: typeof body.instruction === 'string' ? body.instruction : undefined,
      });
      json(res, 201, document);
      return true;
    }
    if (req.method === 'GET' && documentMatch) {
      json(res, 200, await writing.get(writingActor, decodeURIComponent(documentMatch[1]!)));
      return true;
    }
    if ((req.method === 'PATCH' || req.method === 'POST') && documentMatch && pathname.endsWith(documentMatch[0]!)) {
      if (req.method === 'POST') {
        json(res, 404, { error: 'Not found.' });
        return true;
      }
      const body = await readJson(req, options.maxRequestBytes);
      const title = typeof body.title === 'string' ? body.title : '';
      const expectedRevision = Number(body.expectedRevision);
      json(res, 200, await writing.rename(writingActor, decodeURIComponent(documentMatch[1]!), { title, expectedRevision }));
      return true;
    }
    if (req.method === 'DELETE' && documentMatch) {
      const expectedRevision = Number(urlQueryNumber(req, 'expectedRevision'));
      json(
        res,
        200,
        await writing.remove(
          writingActor,
          decodeURIComponent(documentMatch[1]!),
          Number.isFinite(expectedRevision) ? expectedRevision : undefined,
        ),
      );
      return true;
    }
    if (req.method === 'GET' && versionsMatch) {
      json(res, 200, await writing.listVersions(writingActor, decodeURIComponent(versionsMatch[1]!)));
      return true;
    }
    if (req.method === 'GET' && provenanceMatch) {
      json(res, 200, await writing.provenance(writingActor, decodeURIComponent(provenanceMatch[1]!)));
      return true;
    }
    if (req.method === 'POST' && restoreMatch) {
      const body = await readJson(req, options.maxRequestBytes);
      json(
        res,
        200,
        await writing.restore(writingActor, decodeURIComponent(restoreMatch[1]!), {
          version: Number(body.version),
          expectedRevision: Number(body.expectedRevision),
        }),
      );
      return true;
    }
    if (req.method === 'POST' && cancelMatch) {
      json(res, 200, await writing.cancel(writingActor, decodeURIComponent(cancelMatch[1]!)));
      return true;
    }
    if (req.method === 'POST' && editMatch) {
      const body = await readJson(req, options.maxRequestBytes);
      json(
        res,
        200,
        await writing.edit(writingActor, decodeURIComponent(editMatch[1]!), {
          text: typeof body.text === 'string' ? body.text : '',
          expectedRevision: Number(body.expectedRevision),
          title: typeof body.title === 'string' ? body.title : undefined,
        }),
      );
      return true;
    }
    if (req.method === 'GET' && companionsMatch) {
      json(res, 200, await writing.listCompanions(writingActor, decodeURIComponent(companionsMatch[1]!)));
      return true;
    }
    if (req.method === 'POST' && companionsMatch) {
      const body = await readJson(req, options.maxRequestBytes);
      const kind = body.kind === 'canon' || body.kind === 'claims' || body.kind === 'quality' ? body.kind : 'outline';
      json(
        res,
        201,
        await writing.saveCompanion(writingActor, decodeURIComponent(companionsMatch[1]!), {
          kind,
          title: typeof body.title === 'string' ? body.title : kind,
          text: typeof body.text === 'string' ? body.text : '',
        }),
      );
      return true;
    }
    if (req.method === 'POST' && commissionMatch) {
      const body = await readJson(req, options.maxRequestBytes);
      const parsed = writingOperationSchema.safeParse(body.operation ?? 'create');
      if (!parsed.success) {
        json(res, 400, { error: 'Malformed writing operation.', code: 'malformed' });
        return true;
      }
      json(
        res,
        202,
        await writing.commission(writingActor, decodeURIComponent(commissionMatch[1]!), {
          operation: parsed.data,
          instruction: typeof body.instruction === 'string' ? body.instruction : '',
          fileIds: normalizeContextFileIds(body.fileIds),
          expectedRevision: Number(body.expectedRevision),
          privacy: body.privacy === 'local_only' ? 'local_only' : 'any',
          tools: body.tools === true,
        }),
      );
      return true;
    }
    if (req.method === 'GET' && storyBibleMatch) {
      json(res, 200, await writing.getStoryBible(writingActor, decodeURIComponent(storyBibleMatch[1]!)));
      return true;
    }
    if ((req.method === 'PUT' || req.method === 'POST') && storyBibleMatch) {
      const body = await readJson(req, options.maxRequestBytes);
      json(res, 200, await writing.upsertStoryBible(writingActor, decodeURIComponent(storyBibleMatch[1]!), {
        premise: typeof body.premise === 'string' ? body.premise : undefined,
        world: typeof body.world === 'string' ? body.world : undefined,
        voice: typeof body.voice === 'string' ? body.voice : undefined,
        facts: Array.isArray(body.facts) ? body.facts.filter((item: unknown) => typeof item === 'string') : undefined,
        continuity: Array.isArray(body.continuity)
          ? body.continuity.filter((item: unknown) => typeof item === 'string')
          : undefined,
        relationships: Array.isArray(body.relationships)
          ? body.relationships.filter((item: unknown) => typeof item === 'string')
          : undefined,
        characters: Array.isArray(body.characters)
          ? (body.characters as unknown[])
              .flatMap((item) => {
                if (!item || typeof item !== 'object') return [];
                const row = item as { name?: unknown; facts?: unknown };
                if (typeof row.name !== 'string') return [];
                return [{ name: row.name, facts: typeof row.facts === 'string' ? row.facts : '' }];
              })
          : undefined,
      }, { replace: true }));
      return true;
    }
    if (req.method === 'GET' && structureMatch) {
      json(res, 200, await writing.getStructure(writingActor, decodeURIComponent(structureMatch[1]!)));
      return true;
    }
    if (req.method === 'GET' && qualityMatch) {
      json(res, 200, await writing.getQuality(writingActor, decodeURIComponent(qualityMatch[1]!)));
      return true;
    }
    if (req.method === 'POST' && generateMatch) {
      const body = await readJson(req, options.maxRequestBytes);
      const parsed = writingOperationSchema.safeParse(body.operation ?? 'create');
      if (!parsed.success) {
        json(res, 400, { error: 'Malformed writing operation.', code: 'malformed' });
        return true;
      }
      const fileIds = normalizeContextFileIds(body.fileIds);
      options.resources?.assertContextFiles(fileIds.length);
      const origin = matchingOrigin(req, options.allowedOrigins);
      const releaseAdmission = acquireRunAndStreamPermits(options.resources, writingActor.tenantId);
      sseHeaders(res, origin);
      try {
        await pipeSse(
          res,
          writing.generate(writingActor, decodeURIComponent(generateMatch[1]!), {
            operation: parsed.data,
            instruction: typeof body.instruction === 'string' ? body.instruction : '',
            fileIds,
            expectedRevision: Number(body.expectedRevision),
            privacy: body.privacy === 'local_only' ? 'local_only' : 'any',
            tools: body.tools === true,
            commit: body.commit === false ? false : true,
          }),
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
      return true;
    }
    json(res, 404, { error: 'Not found.' });
    return true;
  } catch (err) {
    return handleCaspaError(res, err);
  }
}

function urlQueryNumber(req: IncomingMessage, name: string): number {
  const value = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get(name);
  return value ? Number(value) : Number.NaN;
}

function requireWriting(options: CaspaHostOptions): WritingService {
  if (!options.writing) throw new CaspaUnavailableError('writing_unavailable', 'Caspa requires platform persistence.');
  return options.writing;
}

class CaspaUnavailableError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CaspaUnavailableError';
  }
}

function handleCaspaError(res: ServerResponse, err: unknown): true {
  if (res.headersSent) {
    if (!res.writableEnded && !res.destroyed) {
      const message = err instanceof Error ? err.message : String(err);
      writeSse(res, 'error', {
        type: 'error',
        failure: { code: 'internal', message, retryable: false, at: new Date().toISOString() },
      });
      res.end();
    }
    return true;
  }
  if (err instanceof PlatformHttpError) {
    json(res, err.httpStatus, { error: err.message, code: err.code });
    return true;
  }
  if (err instanceof CaspaUnavailableError) {
    json(res, 503, { error: err.message, code: err.code });
    return true;
  }
  if (err instanceof WritingError) {
    json(res, err.httpStatus, { error: err.message, code: err.code });
    return true;
  }
  if (err instanceof AuthenticationError) {
    json(res, err.code === 'unauthenticated' ? 401 : 403, { error: err.message });
    return true;
  }
  if (err instanceof OwnershipError || err instanceof FilesAccessError || err instanceof AuthorityDeniedError) {
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
  if (err instanceof ConflictError) {
    json(res, 409, { error: 'Document was updated; reload and retry.', code: 'stale_revision' });
    return true;
  }
  if (err instanceof SyntaxError) {
    json(res, 400, { error: 'Malformed JSON.', code: 'malformed' });
    return true;
  }
  throw err;
}

void isMutating;
void header;
