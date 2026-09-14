import { randomUUID } from 'node:crypto';
import type { StructuredFailure } from '@atlas-vnext/contracts';
import { assertActor, sameWorkspace, type PersistenceActor } from '../actor.ts';
import { ConflictError, OwnershipError } from '../errors.ts';
import type { DocumentRecord, DocumentStore, DocumentVersionRecord } from '../document-types.ts';

export function createMemoryDocumentStore(clock: () => string): DocumentStore {
  const documents = new Map<string, DocumentRecord>();
  const versions = new Map<string, DocumentVersionRecord[]>();

  const store: DocumentStore = {
    async create(actor, input) {
      const scoped = assertActor(actor, 'create document');
      if (!sameWorkspace(scoped, input.workspaceId)) {
        throw new OwnershipError('Fail-closed: workspace is not visible.');
      }
      const now = clock();
      const id = input.id ?? `doc_${randomUUID()}`;
      const record: DocumentRecord = {
        id,
        urn: `urn:atlas:document:${id}`,
        tenantId: scoped.tenantId,
        workspaceId: input.workspaceId,
        title: input.title,
        status: 'idle',
        currentVersion: 0,
        revision: 1,
        currentContentHash: null,
        draftContentHash: null,
        currentArtefactId: null,
        draftArtefactId: null,
        conversationId: input.conversationId ?? null,
        originatingRunId: null,
        failure: null,
        createdBy: scoped.principalId ?? null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      documents.set(id, record);
      versions.set(id, []);
      return record;
    },
    async get(actor, id, opts) {
      const scoped = assertActor(actor, 'read document');
      const record = documents.get(id);
      if (!record || record.tenantId !== scoped.tenantId) return null;
      if (!sameWorkspace(scoped, record.workspaceId)) return null;
      if (record.deletedAt && !opts?.includeDeleted) return null;
      return record;
    },
    async list(actor, workspaceId) {
      const scoped = assertActor(actor, 'list documents');
      if (!sameWorkspace(scoped, workspaceId)) return [];
      return [...documents.values()]
        .filter((item) => item.tenantId === scoped.tenantId && item.workspaceId === workspaceId && !item.deletedAt)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async update(actor, id, patch) {
      const current = await requireDocument(actor, id, patch.expectedRevision);
      const now = clock();
      const next: DocumentRecord = {
        ...current,
        title: patch.title ?? current.title,
        status: patch.status ?? current.status,
        conversationId: patch.conversationId === undefined ? current.conversationId : patch.conversationId,
        originatingRunId: patch.originatingRunId === undefined ? current.originatingRunId : patch.originatingRunId,
        draftContentHash: patch.draftContentHash === undefined ? current.draftContentHash : patch.draftContentHash,
        currentContentHash: patch.currentContentHash === undefined ? current.currentContentHash : patch.currentContentHash,
        currentArtefactId: patch.currentArtefactId === undefined ? current.currentArtefactId : patch.currentArtefactId,
        draftArtefactId: patch.draftArtefactId === undefined ? current.draftArtefactId : patch.draftArtefactId,
        failure: patch.failure === undefined ? current.failure : patch.failure,
        revision: current.revision + 1,
        updatedAt: now,
      };
      documents.set(id, next);
      return next;
    },
    async logicalDelete(actor, id, expectedRevision) {
      const current = await requireDocument(actor, id, expectedRevision);
      const now = clock();
      const next: DocumentRecord = {
        ...current,
        deletedAt: now,
        revision: current.revision + 1,
        updatedAt: now,
      };
      documents.set(id, next);
      return next;
    },
    async listInFlight() {
      return [...documents.values()].filter(
        (item) => !item.deletedAt && (item.status === 'requested' || item.status === 'running' || item.status === 'streaming'),
      );
    },
    async addVersion(actor, documentId, input) {
      const current = await requireDocument(actor, documentId, input.expectedRevision);
      const now = clock();
      const versionNumber = current.currentVersion + 1;
      const version: DocumentVersionRecord = {
        id: `dver_${randomUUID()}`,
        documentId,
        tenantId: current.tenantId,
        workspaceId: current.workspaceId,
        version: versionNumber,
        contentHash: input.contentHash,
        artefactId: input.artefactId,
        title: input.title,
        operation: input.operation,
        executionId: input.executionId ?? null,
        createdBy: actor.principalId ?? current.createdBy,
        createdAt: now,
      };
      const next: DocumentRecord = {
        ...current,
        title: input.title,
        status: 'committed',
        currentVersion: versionNumber,
        currentContentHash: input.contentHash,
        currentArtefactId: input.artefactId,
        draftContentHash: null,
        originatingRunId: input.executionId ?? current.originatingRunId,
        failure: null,
        revision: current.revision + 1,
        updatedAt: now,
      };
      documents.set(documentId, next);
      versions.set(documentId, [...(versions.get(documentId) ?? []), version]);
      return { document: next, version };
    },
    async listVersions(actor, documentId) {
      const current = await store.get(actor, documentId);
      if (!current) throw new OwnershipError(`Fail-closed: document ${documentId} is not visible.`);
      return [...(versions.get(documentId) ?? [])];
    },
    async getVersion(actor, documentId, version) {
      const rows = await store.listVersions(actor, documentId);
      return rows.find((item) => item.version === version) ?? null;
    },
  };

  async function requireDocument(actor: PersistenceActor, id: string, expectedRevision?: number): Promise<DocumentRecord> {
    const scoped = assertActor(actor, 'mutate document');
    const record = documents.get(id);
    if (!record || record.tenantId !== scoped.tenantId || record.deletedAt) {
      throw new OwnershipError(`Fail-closed: document ${id} is not visible to tenant ${scoped.tenantId}.`);
    }
    if (!sameWorkspace(scoped, record.workspaceId)) {
      throw new OwnershipError(`Fail-closed: document ${id} is not visible.`);
    }
    if (expectedRevision != null && record.revision !== expectedRevision) {
      throw new ConflictError(`Document ${id} revision ${expectedRevision} does not match ${record.revision}.`);
    }
    return record;
  }

  void (null as StructuredFailure | null);
  return store;
}
