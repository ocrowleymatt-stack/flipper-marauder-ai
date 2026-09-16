import type {
  ConversationStreamEvent,
  ProvenanceRecord,
  StructuredFailure,
  WritingDocument,
  WritingDocumentVersion,
  WritingOperation,
} from '@atlas-vnext/contracts';
import { writingOperationSchema } from '@atlas-vnext/contracts';
import type { ConversationRuntime } from '@atlas-vnext/conversation';
import type { ContextService } from '@atlas-vnext/context';
import type { FilesService } from '@atlas-vnext/files';
import type { PersistenceActor, PlatformPersistence } from '@atlas-vnext/persistence';
import { ConflictError, OwnershipError } from '@atlas-vnext/persistence';
import { AuthorityDeniedError, AuthorityEngine } from '@atlas-vnext/permissions';
import type { ProjectService } from '@atlas-vnext/projects';
import { FilesAccessError } from '@atlas-vnext/files';
import { composeWritingPrompt, writingRouteRequirements } from './behaviour.ts';
import { GENERIC_DENY, WritingError } from './errors.ts';

export interface WritingActor extends PersistenceActor {
  principalId: string;
  tenantId: string;
}

export interface WritingGenerateInput {
  operation: WritingOperation;
  instruction: string;
  fileIds?: string[];
  expectedRevision: number;
  privacy?: 'any' | 'local_only';
  tools?: boolean;
  commit?: boolean;
}

export type WritingStreamEvent =
  | { type: 'document'; document: WritingDocument }
  | { type: 'draft.delta'; documentId: string; text: string }
  | { type: 'execution'; event: ConversationStreamEvent }
  | { type: 'error'; failure: StructuredFailure }
  | { type: 'done' };

export class WritingService {
  constructor(
    private readonly deps: {
      persistence: PlatformPersistence;
      projects: ProjectService;
      files: FilesService;
      context: ContextService;
      runtime: ConversationRuntime;
      authority: AuthorityEngine;
    },
  ) {}

  async create(
    actor: WritingActor,
    input: { projectId: string; title?: string; instruction?: string },
  ): Promise<WritingDocument> {
    const project = await this.requireProject(actor, input.projectId, 'artifact.write');
    const title = (input.title?.trim() || titleFromInstruction(input.instruction) || 'Untitled document').slice(0, 120);
    const record = await this.store(actor).create(actor, { workspaceId: project.id, title });
    return this.present(actor, record);
  }

  async list(actor: WritingActor, projectId: string): Promise<WritingDocument[]> {
    await this.requireProject(actor, projectId, 'artifact.read');
    const rows = await this.store(actor).list(actor, projectId);
    const out: WritingDocument[] = [];
    for (const row of rows) out.push(await this.present(actor, row));
    return out;
  }

  async get(actor: WritingActor, id: string): Promise<WritingDocument> {
    const record = await this.requireDocument(actor, id, 'artifact.read');
    return this.present(actor, record);
  }

  async rename(
    actor: WritingActor,
    id: string,
    input: { title: string; expectedRevision: number },
  ): Promise<WritingDocument> {
    await this.requireDocument(actor, id, 'artifact.write');
    const title = input.title.trim();
    if (!title) throw new WritingError('malformed', 'Title is required.');
    try {
      const updated = await this.store(actor).update(actor, id, { title, expectedRevision: input.expectedRevision });
      return this.present(actor, updated);
    } catch (err) {
      throw this.rewritePersistence(err);
    }
  }

  async remove(actor: WritingActor, id: string, expectedRevision?: number): Promise<WritingDocument> {
    await this.requireDocument(actor, id, 'artifact.write');
    try {
      const deleted = await this.store(actor).logicalDelete(actor, id, expectedRevision);
      return this.present(actor, deleted, { includeContent: false });
    } catch (err) {
      throw this.rewritePersistence(err);
    }
  }

  async listVersions(actor: WritingActor, id: string): Promise<WritingDocumentVersion[]> {
    await this.requireDocument(actor, id, 'artifact.read');
    const rows = await this.store(actor).listVersions(actor, id);
    return rows.map((row) => ({
      id: row.id,
      documentId: row.documentId,
      version: row.version,
      contentHash: row.contentHash,
      artefactId: row.artefactId,
      title: row.title,
      operation: writingOperationSchema.parse(row.operation === 'restore' ? 'restore' : row.operation),
      executionId: row.executionId,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    }));
  }

  async provenance(actor: WritingActor, id: string): Promise<ProvenanceRecord[]> {
    const record = await this.requireDocument(actor, id, 'artifact.read');
    const bound = this.deps.persistence.forActor(actor);
    const versions = await this.store(actor).listVersions(actor, id);
    const entries: ProvenanceRecord[] = [];
    for (const version of versions) {
      entries.push(...(await bound.provenance.forArtefact(version.artefactId)));
    }
    if (record.currentArtefactId) {
      const current = await bound.provenance.forArtefact(record.currentArtefactId);
      for (const entry of current) {
        if (!entries.some((item) => item.artefactId === entry.artefactId && item.traceId === entry.traceId)) {
          entries.push(entry);
        }
      }
    }
    return entries;
  }

  async restore(
    actor: WritingActor,
    id: string,
    input: { version: number; expectedRevision: number },
  ): Promise<WritingDocument> {
    const record = await this.requireDocument(actor, id, 'artifact.write');
    const prior = await this.store(actor).getVersion(actor, id, input.version);
    if (!prior) throw new WritingError('not_found', GENERIC_DENY, 404);
    const text = await this.deps.files.readArtefactText(actor, prior.artefactId);
    return this.commitRevision(actor, record, {
      text,
      operation: 'restore',
      expectedRevision: input.expectedRevision,
      executionId: null,
      fileIds: [],
    });
  }

  async cancel(actor: WritingActor, id: string): Promise<WritingDocument> {
    const record = await this.requireDocument(actor, id, 'artifact.write');
    if (record.originatingRunId) {
      try {
        await this.deps.runtime.cancel(record.originatingRunId);
      } catch {
        // Cancel is idempotent; document seal happens via generate teardown or reconcile.
      }
    }
    return this.present(actor, await this.store(actor).get(actor, id) ?? record);
  }

  async edit(
    actor: WritingActor,
    id: string,
    input: { text: string; expectedRevision: number; title?: string },
  ): Promise<WritingDocument> {
    const record = await this.requireDocument(actor, id, 'artifact.write');
    if (record.revision !== input.expectedRevision) {
      throw new WritingError('stale_revision', 'Document was updated; reload and retry.', 409);
    }
    const text = input.text.trim();
    if (!text) throw new WritingError('malformed', 'Edited text is required.');
    if (input.title?.trim()) {
      await this.store(actor).update(actor, id, { title: input.title.trim(), expectedRevision: record.revision });
    }
    const latest = await this.requireDocument(actor, id, 'artifact.write');
    return this.commitRevision(actor, latest, {
      text,
      operation: 'edit',
      expectedRevision: latest.revision,
      executionId: null,
      fileIds: [],
    });
  }

  async saveCompanion(
    actor: WritingActor,
    documentId: string,
    input: { kind: 'outline' | 'canon' | 'claims' | 'quality'; title: string; text: string },
  ) {
    const record = await this.requireDocument(actor, documentId, 'artifact.write');
    const artefact = await this.deps.files.createTextArtefact(actor, {
      projectId: record.workspaceId,
      text: input.text,
      type: `writing.${input.kind}`,
    });
    const bound = this.deps.persistence.forActor(actor);
    const row = await bound.dungeonRecords.create(actor, {
      workspaceId: record.workspaceId,
      dungeon: 'writing',
      kind: input.kind,
      title: input.title,
      status: 'completed',
      payload: { documentId: record.id },
      artefactId: artefact.id,
      contentHash: artefact.contentHash,
      parentId: record.id,
    });
    await bound.provenance.record({
      artefactId: artefact.id,
      projectId: record.workspaceId,
      sourceInputs: [record.id, record.currentContentHash ?? record.id],
      inputManifestHash: null,
      provider: 'atlas.writing',
      model: `caspa.${input.kind}`,
      toolCalls: [],
      jobId: null,
      timestamp: new Date().toISOString(),
      traceId: `writing:${record.id}:${input.kind}:${row.id}`,
      capability: 'writing',
    });
    return row;
  }

  async listCompanions(actor: WritingActor, documentId: string) {
    await this.requireDocument(actor, documentId, 'artifact.read');
    return this.deps.persistence.forActor(actor).dungeonRecords.list(actor, {
      dungeon: 'writing',
      parentId: documentId,
    });
  }

  async commission(
    actor: WritingActor,
    id: string,
    input: WritingGenerateInput,
  ): Promise<{ jobId: string; document: WritingDocument }> {
    const record = await this.requireDocument(actor, id, 'artifact.write');
    const jobs = this.deps.persistence.forActor(actor).jobs;
    const job = await jobs.enqueue(actor, {
      projectId: record.workspaceId,
      workspaceId: record.workspaceId,
      dungeon: 'writing',
      type: 'writing.commission',
      checkpoint: { documentId: record.id, operation: input.operation },
      idempotencyKey: `writing:${record.id}:commission:${record.revision}`,
    });
    await jobs.waitForRuntime(actor, job.id);
    const claimed = await jobs.resumeFromRuntime(actor, job.id);
    try {
      let presented = await this.present(actor, record);
      for await (const event of this.generate(actor, id, input)) {
        if (event.type === 'document') presented = event.document;
        if (event.type === 'error') {
          await jobs.fail(actor, claimed.id, event.failure);
          return { jobId: claimed.id, document: presented };
        }
      }
      await jobs.complete(actor, claimed.id);
      return { jobId: claimed.id, document: presented };
    } catch (err) {
      await jobs.fail(actor, claimed.id, this.failureFrom(err));
      throw err;
    }
  }

  async *generate(actor: WritingActor, id: string, input: WritingGenerateInput): AsyncGenerator<WritingStreamEvent> {
    const operation = writingOperationSchema.parse(input.operation);
    const instruction = input.instruction.trim();
    if (!instruction) {
      yield { type: 'error', failure: failure('malformed', 'Instruction is required.', false) };
      yield { type: 'done' };
      return;
    }

    let record: Awaited<ReturnType<WritingService['requireDocument']>> | undefined;
    try {
      record = await this.requireDocument(actor, id, 'artifact.write');
    } catch (err) {
      yield { type: 'error', failure: this.failureFrom(err) };
      yield { type: 'done' };
      return;
    }
    if (!record) {
      yield { type: 'error', failure: failure('not_found', GENERIC_DENY, false) };
      yield { type: 'done' };
      return;
    }

    if (record.revision !== input.expectedRevision) {
      yield { type: 'error', failure: failure('stale_revision', 'Document was updated; reload and retry.', false) };
      yield { type: 'done' };
      return;
    }

    const fileIds = unique(input.fileIds ?? []);
    try {
      await this.assertFiles(actor, record.workspaceId, fileIds);
    } catch (err) {
      yield { type: 'error', failure: this.failureFrom(err) };
      yield { type: 'done' };
      return;
    }

    let assembledContext = '';
    const sourceInputs: string[] = [];
    try {
      const context = await this.deps.context.assemble(actor, {
        projectId: record.workspaceId,
        query: instruction,
        tokenBudget: 4000,
        restrictFileIds: fileIds,
        attachmentFileIds: fileIds,
      });
      assembledContext = context.slices
        .map((slice) => `File ${slice.path} (hash ${slice.contentHash.slice(0, 12)}):\n${slice.text}`)
        .join('\n\n');
      for (const slice of context.slices) {
        sourceInputs.push(slice.fileId, slice.contentHash, slice.chunkId);
      }
    } catch (err) {
      yield { type: 'error', failure: failure('retrieval_failed', err instanceof Error ? err.message : String(err), true) };
      yield { type: 'done' };
      return;
    }

    const currentText = await this.readContent(actor, record);
    const behaviour = await this.deps.persistence.forActor(actor).behaviour.resolve(actor.tenantId);
    const composed = composeWritingPrompt({
      behaviour,
      projectContext: assembledContext,
      operation,
      instruction,
      currentDocument: currentText,
    });
    const requirements = writingRouteRequirements({
      operation,
      contentChars: currentText.length + instruction.length,
      selectedFileCount: fileIds.length,
      privacy: input.privacy,
      tools: input.tools,
    });

    let conversationId = record.conversationId;
    if (!conversationId) {
      const conversation = await this.deps.runtime.createConversation({
        title: record.title,
        projectId: record.workspaceId,
      });
      conversationId = conversation.id;
    }

    try {
      record = await this.store(actor).update(actor, record.id, {
        status: 'requested',
        conversationId,
        failure: null,
        expectedRevision: record.revision,
      });
    } catch (err) {
      yield { type: 'error', failure: this.failureFrom(err) };
      yield { type: 'done' };
      return;
    }
    yield { type: 'document', document: await this.present(actor, record, { content: currentText }) };

    for (const fileId of fileIds) {
      try {
        await this.deps.files.attachToConversation(actor, { conversationId, fileId });
      } catch {
        // Attachments are convenience for the run spine; selected files already fed context.
      }
    }

    record = await this.store(actor).update(actor, record.id, {
      status: 'running',
      expectedRevision: record.revision,
    });
    yield { type: 'document', document: await this.present(actor, record, { content: currentText }) };

    let draft = '';
    let persistedDraft = '';
    let visible = false;
    let executionId: string | null = null;
    let committed = false;
    let sealedFailure: StructuredFailure | null = null;
    const persistAccumulatedDraft = async () => {
      const current = record;
      if (!current) return;
      if (draft.trim() && draft !== persistedDraft) {
        record = await this.persistDraft(actor, current, draft);
        persistedDraft = draft;
      }
    };
    const sealFailure = async (nextFailure: StructuredFailure) => {
      const current = record;
      if (!current) {
        throw new Error('Writing generate seal requested before a document was loaded.');
      }
      sealedFailure = nextFailure;
      await persistAccumulatedDraft();
      const latest = record ?? current;
      record = await this.failDocument(actor, latest, {
        draft,
        failure: sealedFailure,
        executionId,
      });
      return record;
    };
    try {
      for await (const event of this.deps.runtime.sendMessage(conversationId, {
        content: composed.layers.requestInstructions,
        systemPrompt: composed.precedence
          .filter((layer) => layer !== 'requestInstructions')
          .map((layer) => composed.layers[layer])
          .join('\n\n'),
        capability: requirements.target,
        privacy: requirements.privacy,
        contextTokens: requirements.contextTokens,
        requireTools: requirements.requireTools,
        allowTools: Boolean(input.tools),
        requireReasoning: requirements.requireReasoning,
        requireCode: requirements.requireCode,
        requireVision: requirements.requireVision,
      })) {
        yield { type: 'execution', event };
        if (event.type === 'execution') executionId = event.execution.id;
        if (event.type === 'assistant.delta') {
          if (event.text) draft += event.text;
          const firstVisible = !visible && Boolean(draft.trim());
          if (firstVisible) visible = true;
          if (event.text) {
            yield { type: 'draft.delta', documentId: record.id, text: event.text };
          }
          if (firstVisible) {
            await persistAccumulatedDraft();
            yield { type: 'document', document: await this.present(actor, record, { content: currentText, draft }) };
          }
        }
        if (event.type === 'assistant.completed') {
          const previous = draft;
          if (event.text) draft = event.text;
          const extra = incrementalCompletedDelta(previous, event.text);
          const firstVisible = !visible && Boolean(draft.trim());
          if (firstVisible) visible = true;
          if (extra) {
            yield { type: 'draft.delta', documentId: record.id, text: extra };
          }
          if (firstVisible) {
            await persistAccumulatedDraft();
            yield { type: 'document', document: await this.present(actor, record, { content: currentText, draft }) };
          }
        }
        const cancelled = event.type === 'execution' && event.execution.status === 'cancelled';
        if (cancelled || event.type === 'execution.failed' || event.type === 'error') {
          const classified = cancelled
            ? failure('cancelled', 'The writing run was cancelled.', false)
            : event.type === 'error' || event.type === 'execution.failed'
              ? event.failure
              : failure('fail_before_visible', 'The writing run failed.', true);
          const code = cancelled
            ? 'cancelled'
            : visible
              ? 'fail_after_visible'
              : classified.code === 'routing_failed'
                ? 'provider_unavailable'
                : 'fail_before_visible';
          const sealed = await sealFailure(failure(code, classified.message, cancelled ? false : !visible));
          yield { type: 'document', document: await this.present(actor, sealed, { content: currentText, draft: draft || null }) };
          yield { type: 'error', failure: sealed.failure ?? sealedFailure ?? classified };
          yield { type: 'done' };
          return;
        }
        if (event.type === 'done') {
          break;
        }
      }

      if (sealedFailure || record.status === 'failed') {
        yield { type: 'done' };
        return;
      }

      if (!draft.trim()) {
        const sealed = await sealFailure(failure('fail_before_visible', 'The writing run produced no visible document text.', true));
        yield { type: 'document', document: await this.present(actor, sealed, { content: currentText }) };
        yield { type: 'error', failure: sealed.failure! };
        yield { type: 'done' };
        return;
      }

      await persistAccumulatedDraft();
      record = await this.store(actor).update(actor, record.id, {
        status: 'candidate',
        originatingRunId: executionId,
        expectedRevision: record.revision,
      });
      yield { type: 'document', document: await this.present(actor, record, { content: currentText, draft }) };

      if (input.commit === false) {
        yield { type: 'done' };
        return;
      }

      const presented = await this.commitRevision(actor, record, {
        text: draft,
        operation,
        expectedRevision: record.revision,
        executionId,
        fileIds,
        sourceInputs: [...sourceInputs, ...(record.currentContentHash ? [record.currentContentHash] : [])],
      });
      committed = true;
      yield { type: 'document', document: presented };
      yield { type: 'done' };
    } catch (err) {
      if (!committed) {
        const classified = this.failureFrom(err, visible);
        try {
          const sealed = await sealFailure(classified);
          yield { type: 'document', document: await this.present(actor, sealed, { content: currentText, draft: draft || null }) };
        } catch {
          // Persistence of the classified failure is best-effort after the run error.
        }
        yield { type: 'error', failure: classified };
      }
      yield { type: 'done' };
    } finally {
      const inflight =
        record &&
        (record.status === 'requested' || record.status === 'running' || record.status === 'streaming');
      if (!committed && inflight && !sealedFailure) {
        const classified = visible
          ? failure('cancelled', 'The writing run was cancelled.', false)
          : failure('fail_before_visible', 'The writing run failed.', true);
        try {
          record = await sealFailure(classified);
        } catch {
          // Best-effort seal on generator teardown (idle timeout, disconnect, return()).
        }
      }
    }
  }

  async reconcile(reason = 'Process restarted before the writing run finished.'): Promise<number> {
    const inflight = await this.deps.persistence.forActor({ tenantId: 'unused', principalId: 'system' }).documents.listInFlight();
    // listInFlight is not tenant-filtered in postgres; memory store returns all. Update per-tenant.
    let count = 0;
    for (const doc of inflight) {
      await this.store({ tenantId: doc.tenantId, principalId: doc.createdBy ?? 'system' }).update(
        { tenantId: doc.tenantId, principalId: doc.createdBy ?? 'system' },
        doc.id,
        {
          status: 'failed',
          failure: failure('interrupted', reason, true),
          expectedRevision: doc.revision,
        },
      );
      count += 1;
    }
    return count;
  }

  private store(actor: WritingActor) {
    return this.deps.persistence.forActor(actor).documents;
  }

  private async requireProject(actor: WritingActor, projectId: string, capability: 'artifact.read' | 'artifact.write' | 'project.read') {
    this.assertActor(actor);
    const project = await this.deps.projects.get(actor, projectId);
    if (!project) throw new WritingError('not_found', GENERIC_DENY, 404);
    this.authorize(actor, capability, {
      type: capability.startsWith('project') ? 'project' : 'artifact',
      id: project.id,
      tenantId: project.tenantId,
      workspaceId: project.id,
    });
    this.authorize(actor, 'project.read', {
      type: 'project',
      id: project.id,
      tenantId: project.tenantId,
      workspaceId: project.id,
    });
    return project;
  }

  private async requireDocument(actor: WritingActor, id: string, capability: 'artifact.read' | 'artifact.write') {
    this.assertActor(actor);
    const record = await this.store(actor).get(actor, id);
    if (!record) throw new WritingError('not_found', GENERIC_DENY, 404);
    this.authorize(actor, capability, {
      type: 'artifact',
      id: record.id,
      tenantId: record.tenantId,
      workspaceId: record.workspaceId,
    });
    this.authorize(actor, 'project.read', {
      type: 'project',
      id: record.workspaceId,
      tenantId: record.tenantId,
      workspaceId: record.workspaceId,
    });
    return record;
  }

  private authorize(
    actor: WritingActor,
    capability: 'artifact.read' | 'artifact.write' | 'project.read' | 'file.read',
    resource: { type: 'artifact' | 'project' | 'file'; id: string; tenantId: string; workspaceId: string },
  ): void {
    const verdict = this.deps.authority.decide({
      principal: {
        principalId: actor.principalId,
        kind: 'user',
        tenantId: actor.tenantId,
        workspaceId: resource.workspaceId,
      },
      capability,
      resource,
    });
    if (verdict.decision !== 'ALLOW') {
      throw new WritingError('permission_denied', GENERIC_DENY, 404);
    }
  }

  private assertActor(actor: WritingActor): void {
    if (!actor.tenantId?.trim() || !actor.principalId?.trim()) {
      throw new WritingError('permission_denied', GENERIC_DENY, 401);
    }
  }

  private async assertFiles(actor: WritingActor, projectId: string, fileIds: string[]): Promise<void> {
    for (const fileId of fileIds) {
      this.authorize(actor, 'file.read', {
        type: 'file',
        id: fileId,
        tenantId: actor.tenantId,
        workspaceId: projectId,
      });
      let meta;
      try {
        meta = await this.deps.files.getMetadata(actor, fileId);
      } catch (err) {
        if (err instanceof FilesAccessError || err instanceof OwnershipError) {
          throw new WritingError('file_unauthorized', GENERIC_DENY, 404);
        }
        throw err;
      }
      if (!meta) throw new WritingError('file_missing', GENERIC_DENY, 404);
      if (meta.workspaceId !== projectId) throw new WritingError('file_unauthorized', GENERIC_DENY, 404);
    }
  }

  private async readContent(actor: WritingActor, record: { currentArtefactId: string | null }): Promise<string> {
    if (!record.currentArtefactId) return '';
    try {
      return await this.deps.files.readArtefactText(actor, record.currentArtefactId);
    } catch {
      return '';
    }
  }

  private async readDraft(actor: WritingActor, record: { draftArtefactId: string | null }): Promise<string | null> {
    if (!record.draftArtefactId) return null;
    try {
      return await this.deps.files.readArtefactText(actor, record.draftArtefactId);
    } catch {
      return null;
    }
  }

  private async persistDraft(
    actor: WritingActor,
    record: Awaited<ReturnType<WritingService['requireDocument']>>,
    text: string,
  ) {
    const artefact = await this.deps.files.createTextArtefact(actor, {
      projectId: record.workspaceId,
      text,
      type: 'writing.draft',
    });
    return this.store(actor).update(actor, record.id, {
      status: 'streaming',
      draftContentHash: artefact.contentHash,
      draftArtefactId: artefact.id,
      expectedRevision: record.revision,
    });
  }

  private async failDocument(
    actor: WritingActor,
    record: Awaited<ReturnType<WritingService['requireDocument']>>,
    input: { draft: string; failure: StructuredFailure; executionId: string | null },
  ) {
    const apply = async (current: Awaited<ReturnType<WritingService['requireDocument']>>) => {
      let next = current;
      if (input.draft.trim()) {
        next = await this.persistDraft(actor, next, input.draft);
      }
      return this.store(actor).update(actor, next.id, {
        status: 'failed',
        originatingRunId: input.executionId,
        failure: input.failure,
        expectedRevision: next.revision,
      });
    };
    try {
      return await apply(record);
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      const latest = await this.store(actor).get(actor, record.id);
      if (!latest) throw err;
      return apply(latest);
    }
  }

  private async commitRevision(
    actor: WritingActor,
    record: Awaited<ReturnType<WritingService['requireDocument']>>,
    input: {
      text: string;
      operation: WritingOperation;
      expectedRevision: number;
      executionId: string | null;
      fileIds: string[];
      sourceInputs?: string[];
    },
  ): Promise<WritingDocument> {
    let artefact;
    if (record.currentArtefactId) {
      const current = await this.deps.persistence.artefacts.get(actor, record.currentArtefactId);
      artefact = await this.deps.files.versionTextArtefact(actor, record.currentArtefactId, {
        text: input.text,
        expectedVersion: current?.version ?? 1,
      });
    } else {
      artefact = await this.deps.files.createTextArtefact(actor, {
        projectId: record.workspaceId,
        text: input.text,
        type: 'writing.document',
      });
    }
    const execution = input.executionId ? await this.deps.runtime.getExecution(input.executionId) : null;
    const committed = await this.deps.persistence.run(async () => {
      const versioned = await this.store(actor).addVersion(actor, record.id, {
        contentHash: artefact.contentHash ?? '',
        artefactId: artefact.id,
        title: record.title,
        operation: input.operation,
        executionId: input.executionId,
        expectedRevision: input.expectedRevision,
      });
      await this.deps.persistence.forActor(actor).provenance.record({
        artefactId: artefact.id,
        projectId: record.workspaceId,
        sourceInputs: unique([
          ...(input.sourceInputs ?? []),
          ...input.fileIds,
          ...(record.currentContentHash ? [record.currentContentHash] : []),
        ]),
        inputManifestHash: null,
        provider: execution?.selectedProvider ?? execution?.route?.provider ?? 'atlas.writing',
        model: execution?.selectedModel ?? execution?.route?.model ?? 'caspa.document',
        toolCalls: [],
        jobId: input.executionId,
        timestamp: new Date().toISOString(),
        traceId: `writing:${record.id}:v${versioned.document.currentVersion}`,
        capability: 'writing',
        selectedRouteId: execution?.route?.resolvedRouteId,
        locality: execution?.route?.locality,
        attemptOutcomes: execution?.attempts.map((attempt) => ({
          provider: attempt.provider,
          model: attempt.model,
          outcome: attempt.outcome,
          emittedVisibleOutput: attempt.emittedVisibleOutput,
        })),
      });
      return versioned;
    });
    return this.present(actor, committed.document, { content: input.text });
  }

  private async present(
    actor: WritingActor,
    record: Awaited<ReturnType<WritingService['requireDocument']>>,
    overlay?: { content?: string; draft?: string | null; includeContent?: boolean },
  ): Promise<WritingDocument> {
    const content = overlay?.includeContent === false ? '' : overlay?.content ?? (await this.readContent(actor, record));
    const draft =
      overlay && 'draft' in overlay ? overlay.draft ?? null : record.status === 'streaming' || record.status === 'candidate' || record.status === 'failed'
        ? await this.readDraft(actor, record)
        : null;
    return {
      id: record.id,
      urn: record.urn,
      projectId: record.workspaceId,
      title: record.title,
      status: record.status,
      currentVersion: record.currentVersion,
      revision: record.revision,
      content,
      draft,
      currentContentHash: record.currentContentHash,
      draftContentHash: record.draftContentHash,
      originatingRunId: record.originatingRunId,
      conversationId: record.conversationId,
      failure: record.failure,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private rewritePersistence(err: unknown): WritingError {
    if (err instanceof WritingError) return err;
    if (err instanceof ConflictError) return new WritingError('stale_revision', 'Document was updated; reload and retry.', 409);
    if (err instanceof OwnershipError || err instanceof FilesAccessError || err instanceof AuthorityDeniedError) {
      return new WritingError('permission_denied', GENERIC_DENY, 404);
    }
    return new WritingError('malformed', err instanceof Error ? err.message : String(err));
  }

  private failureFrom(err: unknown, visible = false): StructuredFailure {
    if (err instanceof WritingError) return failure(err.code, err.message, false);
    if (err instanceof ConflictError) return failure('stale_revision', 'Document was updated; reload and retry.', false);
    return failure(visible ? 'fail_after_visible' : 'fail_before_visible', err instanceof Error ? err.message : String(err), !visible);
  }
}

function titleFromInstruction(instruction?: string): string | null {
  const text = instruction?.trim();
  if (!text) return null;
  return text.split(/\n/)[0]!.slice(0, 72);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function incrementalCompletedDelta(assembled: string, completed: string): string {
  if (!completed || completed === assembled) return '';
  if (assembled && completed.startsWith(assembled)) return completed.slice(assembled.length);
  if (!assembled) return completed;
  return '';
}

function failure(code: string, message: string, retryable: boolean): StructuredFailure {
  return { code, message, retryable, at: new Date().toISOString() };
}
