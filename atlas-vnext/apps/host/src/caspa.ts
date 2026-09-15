import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuthenticationError } from '@atlas-vnext/auth';
import { CASPA_WRITING_DUNGEON, WritingError, WritingService, type WritingActor } from '@atlas-vnext/dungeon-writing';
import { writingOperationSchema } from '@atlas-vnext/contracts';
import { CasMissingError, FilesAccessError } from '@atlas-vnext/files';
import { ConflictError, OwnershipError, PersistenceClosedError, PersistenceUnavailableError, isPersistenceConnectionLoss } from '@atlas-vnext/persistence';
import { AuthorityDeniedError } from '@atlas-vnext/permissions';
import { header, isMutating, json, readJson, sseHeaders, urlPath, writeSse } from './http.ts';
import { resolveActor, type WorkbenchHostOptions } from './workbench.ts';

export interface CaspaHostOptions extends WorkbenchHostOptions {
  writing?: WritingService | null;
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
    json(res, 200, [CASPA_WRITING_DUNGEON]);
    return true;
  }

  const projectDocs = pathname.match(/^\/api\/projects\/([^/]+)\/documents$/);
  const documentMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
  const generateMatch = pathname.match(/^\/api\/documents\/([^/]+)\/generate$/);
  const versionsMatch = pathname.match(/^\/api\/documents\/([^/]+)\/versions$/);
  const restoreMatch = pathname.match(/^\/api\/documents\/([^/]+)\/restore$/);
  const provenanceMatch = pathname.match(/^\/api\/documents\/([^/]+)\/provenance$/);

  if (!projectDocs && !documentMatch && !generateMatch && !versionsMatch && !restoreMatch && !provenanceMatch) {
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
    if (req.method === 'POST' && generateMatch) {
      const body = await readJson(req, options.maxRequestBytes);
      const parsed = writingOperationSchema.safeParse(body.operation ?? 'create');
      if (!parsed.success) {
        json(res, 400, { error: 'Malformed writing operation.', code: 'malformed' });
        return true;
      }
      sseHeaders(res);
      for await (const event of writing.generate(writingActor, decodeURIComponent(generateMatch[1]!), {
        operation: parsed.data,
        instruction: typeof body.instruction === 'string' ? body.instruction : '',
        fileIds: Array.isArray(body.fileIds) ? body.fileIds.filter((item): item is string => typeof item === 'string') : [],
        expectedRevision: Number(body.expectedRevision),
        privacy: body.privacy === 'local_only' ? 'local_only' : 'any',
        tools: body.tools === true,
        commit: body.commit === false ? false : true,
      })) {
        writeSse(res, event.type, event);
        if (res.destroyed) break;
      }
      res.end();
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
