import { randomUUID } from 'node:crypto';
import type { StructuredFailure } from '@atlas-vnext/contracts';
import { logPlatform } from '@atlas-vnext/observability';
import { assertActor, type PersistenceActor } from '../actor.ts';
import { ConflictError, OwnershipError } from '../errors.ts';
import type { DocumentRecord, DocumentStore, DocumentStatus, DocumentVersionRecord } from '../document-types.ts';
import { asJson, isoRequired, sqlRow } from './mappers.ts';
import type { PgTx } from './tx.ts';

interface DocumentRow {
  id: string;
  urn: string;
  tenant_id: string;
  workspace_id: string;
  title: string;
  status: string;
  current_version: number;
  revision: number;
  current_content_hash: string | null;
  draft_content_hash: string | null;
  current_artefact_id: string | null;
  draft_artefact_id: string | null;
  conversation_id: string | null;
  originating_run_id: string | null;
  failure: unknown;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
}

interface DocumentVersionRow {
  id: string;
  document_id: string;
  tenant_id: string;
  workspace_id: string;
  version: number;
  content_hash: string;
  artefact_id: string;
  title: string;
  operation: string;
  execution_id: string | null;
  created_by: string | null;
  created_at: Date | string;
}

function mapDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    urn: row.urn,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    title: row.title,
    status: row.status as DocumentStatus,
    currentVersion: Number(row.current_version),
    revision: Number(row.revision),
    currentContentHash: row.current_content_hash,
    draftContentHash: row.draft_content_hash,
    currentArtefactId: row.current_artefact_id,
    draftArtefactId: row.draft_artefact_id,
    conversationId: row.conversation_id,
    originatingRunId: row.originating_run_id,
    failure: asJson<StructuredFailure | null>(row.failure, null),
    createdBy: row.created_by,
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
    deletedAt: row.deleted_at ? isoRequired(row.deleted_at) : null,
  };
}

function mapVersion(row: DocumentVersionRow): DocumentVersionRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    version: Number(row.version),
    contentHash: row.content_hash,
    artefactId: row.artefact_id,
    title: row.title,
    operation: row.operation,
    executionId: row.execution_id,
    createdBy: row.created_by,
    createdAt: isoRequired(row.created_at),
  };
}

export function createDocumentStore(tx: PgTx, clock: () => string): DocumentStore {
  async function load(actor: PersistenceActor, id: string, action: string, forUpdate = false): Promise<DocumentRow> {
    const result = await tx.query<DocumentRow>(
      `SELECT * FROM documents WHERE id = $1 AND tenant_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [id, actor.tenantId],
    );
    const row = result.rows[0];
    if (!row || (actor.workspaceId && row.workspace_id !== actor.workspaceId) || row.deleted_at) {
      logPlatform('ownership.rejected', { action, tenantId: actor.tenantId, documentId: id });
      throw new OwnershipError(`Fail-closed: document ${id} is not visible to tenant ${actor.tenantId}.`);
    }
    return row;
  }

  function revisionConflict(id: string, expectedRevision: number, actual: number): ConflictError {
    return new ConflictError(`Document ${id} revision ${expectedRevision} does not match ${actual}.`);
  }

  async function lockedMutation(
    actor: PersistenceActor,
    id: string,
    action: string,
    expectedRevision: number | undefined,
    write: (current: DocumentRow) => Promise<DocumentRow | undefined>,
  ): Promise<DocumentRecord> {
    return tx.run(async () => {
      const scoped = assertActor(actor, action);
      const current = await load(scoped, id, action, true);
      const actual = Number(current.revision);
      if (expectedRevision != null && actual !== expectedRevision) {
        throw revisionConflict(id, expectedRevision, actual);
      }
      const row = await write(current);
      if (!row) {
        throw revisionConflict(id, expectedRevision ?? actual, actual);
      }
      return mapDocument(sqlRow(row));
    });
  }

  const store: DocumentStore = {
    async create(actor, input) {
      const scoped = assertActor(actor, 'create document');
      const now = clock();
      const id = input.id ?? `doc_${randomUUID()}`;
      const result = await tx.query<DocumentRow>(
        `INSERT INTO documents (
           id, urn, tenant_id, workspace_id, title, status, current_version, revision,
           current_content_hash, draft_content_hash, current_artefact_id, draft_artefact_id, conversation_id,
           originating_run_id, failure, created_by, created_at, updated_at, deleted_at
         ) VALUES ($1,$2,$3,$4,$5,'idle',0,1,NULL,NULL,NULL,NULL,$6,NULL,NULL,$7,$8,$8,NULL)
         RETURNING *`,
        [id, `urn:atlas:document:${id}`, scoped.tenantId, input.workspaceId, input.title, input.conversationId ?? null, scoped.principalId ?? null, now],
      );
      return mapDocument(sqlRow(result.rows[0]!));
    },
    async get(actor, id, opts) {
      const scoped = assertActor(actor, 'read document');
      const result = await tx.query<DocumentRow>('SELECT * FROM documents WHERE id = $1 AND tenant_id = $2', [
        id,
        scoped.tenantId,
      ]);
      const row = result.rows[0];
      if (!row) return null;
      if (scoped.workspaceId && row.workspace_id !== scoped.workspaceId) return null;
      if (row.deleted_at && !opts?.includeDeleted) return null;
      return mapDocument(sqlRow(row));
    },
    async list(actor, workspaceId) {
      const scoped = assertActor(actor, 'list documents');
      if (scoped.workspaceId && scoped.workspaceId !== workspaceId) return [];
      const result = await tx.query<DocumentRow>(
        `SELECT * FROM documents
         WHERE tenant_id = $1 AND workspace_id = $2 AND deleted_at IS NULL
         ORDER BY updated_at DESC`,
        [scoped.tenantId, workspaceId],
      );
      return result.rows.map((row) => mapDocument(sqlRow(row)));
    },
    async update(actor, id, patch) {
      return lockedMutation(actor, id, 'update document', patch.expectedRevision, async (current) => {
        const now = clock();
        const result = await tx.query<DocumentRow>(
          `UPDATE documents SET
             title = $3,
             status = $4,
             conversation_id = $5,
             originating_run_id = $6,
             draft_content_hash = $7,
             current_content_hash = $8,
             current_artefact_id = $9,
             draft_artefact_id = $10,
             failure = $11::jsonb,
             revision = revision + 1,
             updated_at = $12
           WHERE id = $1 AND tenant_id = $2 AND revision = $13 AND deleted_at IS NULL
           RETURNING *`,
          [
            id,
            current.tenant_id,
            patch.title ?? current.title,
            patch.status ?? current.status,
            patch.conversationId === undefined ? current.conversation_id : patch.conversationId,
            patch.originatingRunId === undefined ? current.originating_run_id : patch.originatingRunId,
            patch.draftContentHash === undefined ? current.draft_content_hash : patch.draftContentHash,
            patch.currentContentHash === undefined ? current.current_content_hash : patch.currentContentHash,
            patch.currentArtefactId === undefined ? current.current_artefact_id : patch.currentArtefactId,
            patch.draftArtefactId === undefined ? current.draft_artefact_id : patch.draftArtefactId,
            JSON.stringify(patch.failure === undefined ? current.failure : patch.failure),
            now,
            patch.expectedRevision,
          ],
        );
        return result.rows[0];
      });
    },
    async logicalDelete(actor, id, expectedRevision) {
      return lockedMutation(actor, id, 'delete document', expectedRevision, async (current) => {
        const now = clock();
        const revisionClause = expectedRevision == null ? '' : ' AND revision = $4';
        const params: unknown[] = [id, current.tenant_id, now];
        if (expectedRevision != null) params.push(expectedRevision);
        const result = await tx.query<DocumentRow>(
          `UPDATE documents SET deleted_at = $3, revision = revision + 1, updated_at = $3
           WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL${revisionClause}
           RETURNING *`,
          params,
        );
        return result.rows[0];
      });
    },
    async listInFlight() {
      const result = await tx.query<DocumentRow>(
        `SELECT * FROM documents
         WHERE deleted_at IS NULL AND status IN ('requested', 'running', 'streaming')`,
      );
      return result.rows.map((row) => mapDocument(sqlRow(row)));
    },
    async addVersion(actor, documentId, input) {
      return tx.run(async () => {
        const scoped = assertActor(actor, 'version document');
        const current = await load(scoped, documentId, 'version document', true);
        const actual = Number(current.revision);
        if (actual !== input.expectedRevision) {
          throw revisionConflict(documentId, input.expectedRevision, actual);
        }
        const now = clock();
        const versionNumber = Number(current.current_version) + 1;
        const versionId = `dver_${randomUUID()}`;
        await tx.query(
          `INSERT INTO document_versions (
             id, document_id, tenant_id, workspace_id, version, content_hash, artefact_id,
             title, operation, execution_id, created_by, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            versionId,
            documentId,
            scoped.tenantId,
            current.workspace_id,
            versionNumber,
            input.contentHash,
            input.artefactId,
            input.title,
            input.operation,
            input.executionId ?? null,
            scoped.principalId ?? current.created_by,
            now,
          ],
        );
        const result = await tx.query<DocumentRow>(
          `UPDATE documents SET
             title = $3,
             status = 'committed',
             current_version = $4,
             current_content_hash = $5,
             current_artefact_id = $6,
             draft_content_hash = NULL,
             originating_run_id = COALESCE($7, originating_run_id),
             failure = NULL,
             revision = revision + 1,
             updated_at = $8
           WHERE id = $1 AND tenant_id = $2 AND revision = $9 AND deleted_at IS NULL
           RETURNING *`,
          [
            documentId,
            scoped.tenantId,
            input.title,
            versionNumber,
            input.contentHash,
            input.artefactId,
            input.executionId ?? null,
            now,
            input.expectedRevision,
          ],
        );
        if (!result.rows[0]) {
          throw revisionConflict(documentId, input.expectedRevision, actual);
        }
        const document = mapDocument(sqlRow(result.rows[0]));
        const versionRow = await tx.query<DocumentVersionRow>('SELECT * FROM document_versions WHERE id = $1', [versionId]);
        return { document, version: mapVersion(sqlRow(versionRow.rows[0]!)) };
      });
    },
    async listVersions(actor, documentId) {
      await load(assertActor(actor, 'list document versions'), documentId, 'list document versions');
      const result = await tx.query<DocumentVersionRow>(
        'SELECT * FROM document_versions WHERE document_id = $1 AND tenant_id = $2 ORDER BY version ASC',
        [documentId, actor.tenantId],
      );
      return result.rows.map((row) => mapVersion(sqlRow(row)));
    },
    async getVersion(actor, documentId, version) {
      const rows = await store.listVersions(actor, documentId);
      return rows.find((item) => item.version === version) ?? null;
    },
  };
  return store;
}
