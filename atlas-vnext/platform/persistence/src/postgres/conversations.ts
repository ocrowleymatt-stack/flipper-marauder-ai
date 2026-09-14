import { UuidIdFactory, type ConversationRepository, type ExecutionRepository, type MessageRepository, type ProvenanceWriter } from '@atlas-vnext/conversation';
import type { Conversation, ExecutionRecord, Message, ProvenanceRecord } from '@atlas-vnext/contracts';
import { logPlatform } from '@atlas-vnext/observability';
import { OwnershipError } from '../errors.ts';
import { assertActor, sameWorkspace, type PersistenceActor } from '../actor.ts';
import { mapConversation, mapExecution, mapMessage, mapProvenance, sqlRow, type ConversationRow, type ExecutionRow, type MessageRow } from './mappers.ts';
import type { PgTx } from './tx.ts';

const ids = new UuidIdFactory();

async function loadConversation(tx: PgTx, actor: PersistenceActor, id: string, action: string, forUpdate = false): Promise<ConversationRow> {
  const result = await tx.query<ConversationRow>(
    `SELECT * FROM conversations WHERE id = $1 AND tenant_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [id, actor.tenantId],
  );
  const row = result.rows[0];
  if (!row || !sameWorkspace(actor, row.workspace_id)) {
    logPlatform('ownership.rejected', { action, tenantId: actor.tenantId, conversationId: id });
    throw new OwnershipError(`Fail-closed: conversation ${id} is not visible to this tenant.`);
  }
  return row;
}

export function createConversationRepos(tx: PgTx, actor: PersistenceActor, clock: () => string) {
  const scoped = () => assertActor(actor, 'conversation operation');

  const conversations: ConversationRepository = {
    async create(input) {
      const owner = scoped();
      if (input.idempotencyKey) {
        const existing = await tx.query<ConversationRow>(
          'SELECT * FROM conversations WHERE tenant_id = $1 AND idempotency_key = $2',
          [owner.tenantId, input.idempotencyKey],
        );
        if (existing.rows[0]) return mapConversation(existing.rows[0]);
      }
      // projectId is a workspace-id alias until first-class Project objects exist.
      const workspaceId = input.projectId ?? owner.workspaceId ?? null;
      if (workspaceId) {
        const workspace = await tx.query('SELECT id FROM workspaces WHERE id = $1 AND tenant_id = $2', [
          workspaceId,
          owner.tenantId,
        ]);
        if (!workspace.rows[0]) {
          throw new OwnershipError(`Fail-closed: workspace ${workspaceId} is not visible to tenant ${owner.tenantId}.`);
        }
      }
      const id = ids.id('conversation');
      const timestamp = clock();
      try {
        const inserted = await tx.query<ConversationRow>(
          `INSERT INTO conversations (id, urn, tenant_id, workspace_id, title, created_at, updated_at, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $6, $7)
           RETURNING *`,
          [id, ids.urn('conversation', id), owner.tenantId, workspaceId, input.title, timestamp, input.idempotencyKey ?? null],
        );
        return mapConversation(inserted.rows[0]!);
      } catch (err) {
        if ((err as { code?: string }).code === '23505' && input.idempotencyKey) {
          const existing = await tx.query<ConversationRow>(
            'SELECT * FROM conversations WHERE tenant_id = $1 AND idempotency_key = $2',
            [owner.tenantId, input.idempotencyKey],
          );
          if (existing.rows[0]) return mapConversation(existing.rows[0]);
        }
        throw err;
      }
    },
    async get(id) {
      const owner = scoped();
      const result = await tx.query<ConversationRow>(
        'SELECT * FROM conversations WHERE id = $1 AND tenant_id = $2',
        [id, owner.tenantId],
      );
      const row = result.rows[0];
      if (!row || !sameWorkspace(owner, row.workspace_id)) return null;
      return mapConversation(row);
    },
    async list() {
      const owner = scoped();
      const result = owner.workspaceId
        ? await tx.query<ConversationRow>(
            'SELECT * FROM conversations WHERE tenant_id = $1 AND workspace_id = $2 ORDER BY updated_at DESC',
            [owner.tenantId, owner.workspaceId],
          )
        : await tx.query<ConversationRow>(
            'SELECT * FROM conversations WHERE tenant_id = $1 ORDER BY updated_at DESC',
            [owner.tenantId],
          );
      return result.rows.map(mapConversation);
    },
    async save(conversation) {
      const owner = scoped();
      await loadConversation(tx, owner, conversation.id, 'save conversation');
      const result = await tx.query<ConversationRow>(
        `UPDATE conversations SET title = $3, workspace_id = $4, updated_at = $5
         WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
        [conversation.id, owner.tenantId, conversation.title, conversation.projectId ?? conversation.workspaceId ?? null, conversation.updatedAt],
      );
      return mapConversation(result.rows[0]!);
    },
  };

  const messages: MessageRepository = {
    async append(input) {
      const owner = scoped();
      await loadConversation(tx, owner, input.conversationId, 'append message', true);
      if (input.idempotencyKey) {
        const existing = await tx.query<MessageRow>(
          'SELECT * FROM messages WHERE tenant_id = $1 AND idempotency_key = $2',
          [owner.tenantId, input.idempotencyKey],
        );
        if (existing.rows[0]) return mapMessage(existing.rows[0]);
      }
      const seqRow = await tx.query<{ sequence: number }>(
        'SELECT COALESCE(MAX(sequence), -1) AS sequence FROM messages WHERE conversation_id = $1',
        [input.conversationId],
      );
      const sequence = Number(seqRow.rows[0]?.sequence ?? -1) + 1;
      const id = ids.id('message');
      const timestamp = clock();
      try {
        const inserted = await tx.query<MessageRow>(
          `INSERT INTO messages (id, urn, tenant_id, conversation_id, role, content, sequence, execution_id, created_at, updated_at, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)
           RETURNING *`,
          [id, ids.urn('message', id), owner.tenantId, input.conversationId, input.role, input.content, sequence, input.executionId, timestamp, input.idempotencyKey ?? null],
        );
        return mapMessage(inserted.rows[0]!);
      } catch (err) {
        if ((err as { code?: string }).code === '23505' && input.idempotencyKey) {
          const existing = await tx.query<MessageRow>(
            'SELECT * FROM messages WHERE tenant_id = $1 AND idempotency_key = $2',
            [owner.tenantId, input.idempotencyKey],
          );
          if (existing.rows[0]) return mapMessage(existing.rows[0]);
        }
        throw err;
      }
    },
    async list(conversationId) {
      const owner = scoped();
      const conversation = await conversations.get(conversationId);
      if (!conversation) return [];
      const result = await tx.query<MessageRow>(
        'SELECT * FROM messages WHERE conversation_id = $1 AND tenant_id = $2 ORDER BY sequence ASC',
        [conversationId, owner.tenantId],
      );
      return result.rows.map(mapMessage);
    },
    async save(message) {
      const owner = scoped();
      await loadConversation(tx, owner, message.conversationId, 'save message');
      const result = await tx.query<MessageRow>(
        `UPDATE messages SET content = $3, execution_id = $4, updated_at = $5
         WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
        [message.id, owner.tenantId, message.content, message.executionId, message.updatedAt],
      );
      if (!result.rows[0]) {
        throw new OwnershipError(`Fail-closed: message ${message.id} is not visible to this tenant.`);
      }
      return mapMessage(result.rows[0]);
    },
  };

  const executions: ExecutionRepository = {
    async create(record) {
      const owner = scoped();
      await loadConversation(tx, owner, record.conversationId, 'create execution');
      const existingTurn = await tx.query<ExecutionRow>(
        'SELECT * FROM executions WHERE conversation_id = $1 AND user_message_id = $2 AND tenant_id = $3',
        [record.conversationId, record.userMessageId, owner.tenantId],
      );
      if (existingTurn.rows[0]) return mapExecution(existingTurn.rows[0]);
      try {
        const inserted = await tx.query<ExecutionRow>(
          `INSERT INTO executions (
             id, urn, tenant_id, conversation_id, user_message_id, assistant_message_id, status, capability,
             route, selected_provider, selected_model, attempts, usage, failure_reason, latency_ms,
             created_at, updated_at, started_at, completed_at, idempotency_key
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19,$20)
           RETURNING *`,
          [
            record.id,
            record.urn,
            owner.tenantId,
            record.conversationId,
            record.userMessageId,
            record.assistantMessageId,
            record.status,
            record.capability,
            json(record.route),
            record.selectedProvider,
            record.selectedModel,
            json(record.attempts),
            json(record.usage),
            json(record.failureReason),
            record.latencyMs ?? null,
            record.createdAt,
            record.updatedAt,
            record.startedAt,
            record.completedAt,
            record.id,
          ],
        );
        return mapExecution(inserted.rows[0]!);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          const existing = await tx.query<ExecutionRow>(
            'SELECT * FROM executions WHERE conversation_id = $1 AND user_message_id = $2 AND tenant_id = $3',
            [record.conversationId, record.userMessageId, owner.tenantId],
          );
          if (existing.rows[0]) return mapExecution(existing.rows[0]);
          const byId = await tx.query<ExecutionRow>(
            'SELECT * FROM executions WHERE id = $1 AND tenant_id = $2',
            [record.id, owner.tenantId],
          );
          if (byId.rows[0]) return mapExecution(byId.rows[0]);
        }
        throw err;
      }
    },
    async get(id) {
      const owner = scoped();
      const result = await tx.query<ExecutionRow>(
        'SELECT * FROM executions WHERE id = $1 AND tenant_id = $2',
        [id, owner.tenantId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const conversation = await conversations.get(row.conversation_id);
      if (!conversation) return null;
      return mapExecution(row);
    },
    async listByConversation(conversationId) {
      const owner = scoped();
      const conversation = await conversations.get(conversationId);
      if (!conversation) return [];
      const result = await tx.query<ExecutionRow>(
        'SELECT * FROM executions WHERE conversation_id = $1 AND tenant_id = $2 ORDER BY created_at ASC',
        [conversationId, owner.tenantId],
      );
      return result.rows.map(mapExecution);
    },
    async save(record) {
      const owner = scoped();
      await loadConversation(tx, owner, record.conversationId, 'save execution');
      const current = await tx.query<ExecutionRow>(
        'SELECT * FROM executions WHERE id = $1 AND tenant_id = $2',
        [record.id, owner.tenantId],
      );
      const existing = current.rows[0] ? mapExecution(current.rows[0]) : null;
      if (
        existing &&
        (existing.status === 'completed' || existing.status === 'failed' || existing.status === 'cancelled') &&
        existing.status === record.status
      ) {
        return existing;
      }
      const result = await tx.query<ExecutionRow>(
        `UPDATE executions SET
           assistant_message_id = $3, status = $4, capability = $5, route = $6::jsonb,
           selected_provider = $7, selected_model = $8, attempts = $9::jsonb, usage = $10::jsonb,
           failure_reason = $11::jsonb, latency_ms = $12, updated_at = $13, started_at = $14, completed_at = $15
         WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
        [
          record.id,
          owner.tenantId,
          record.assistantMessageId,
          record.status,
          record.capability,
          json(record.route),
          record.selectedProvider,
          record.selectedModel,
          json(record.attempts),
          json(record.usage),
          json(record.failureReason),
          record.latencyMs ?? null,
          record.updatedAt,
          record.startedAt,
          record.completedAt,
        ],
      );
      if (!result.rows[0]) {
        throw new OwnershipError(`Fail-closed: execution ${record.id} is not visible to this tenant.`);
      }
      return mapExecution(result.rows[0]);
    },
    async listInFlight() {
      const owner = scoped();
      const result = owner.workspaceId
        ? await tx.query<ExecutionRow>(
            `SELECT e.* FROM executions e
             JOIN conversations c ON c.id = e.conversation_id
             WHERE e.tenant_id = $1 AND c.workspace_id = $2 AND e.status IN ('queued', 'running')`,
            [owner.tenantId, owner.workspaceId],
          )
        : await tx.query<ExecutionRow>(
            `SELECT * FROM executions WHERE tenant_id = $1 AND status IN ('queued', 'running')`,
            [owner.tenantId],
          );
      return result.rows.map(mapExecution);
    },
  };

  const provenance: ProvenanceWriter = {
    async record(entry: ProvenanceRecord) {
      const owner = scoped();
      await tx.query(
        `INSERT INTO provenance (
           id, tenant_id, artefact_id, project_id, source_inputs, input_manifest_hash, provider, model,
           tool_calls, job_id, timestamp, trace_id, capability, usage, locality, latency_ms,
           selected_route_id, attempt_outcomes, artefact_hash
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18::jsonb,NULL)
         ON CONFLICT (id) DO NOTHING`,
        [
          `prv_${entry.artefactId}`,
          owner.tenantId,
          entry.artefactId,
          entry.projectId,
          json(entry.sourceInputs),
          entry.inputManifestHash,
          entry.provider,
          entry.model,
          json(entry.toolCalls),
          entry.jobId,
          entry.timestamp,
          entry.traceId,
          entry.capability ?? null,
          json(entry.usage ?? null),
          entry.locality ?? null,
          entry.latencyMs ?? null,
          entry.selectedRouteId ?? null,
          json(entry.attemptOutcomes ?? null),
        ],
      );
    },
    async forJob(jobId) {
      const owner = scoped();
      const result = await tx.query(
        'SELECT * FROM provenance WHERE job_id = $1 AND tenant_id = $2 ORDER BY timestamp ASC',
        [jobId, owner.tenantId],
      );
      return result.rows.map((row) => mapProvenance(sqlRow(row)));
    },
  };

  return { conversations, messages, executions, provenance };
}

function json(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}
