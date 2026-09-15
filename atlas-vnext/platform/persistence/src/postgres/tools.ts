import type { ToolApproval, ToolInvocation, ToolInvocationStatus } from '@atlas-vnext/contracts';
import type { ToolApprovalStore, ToolInvocationStore } from '@atlas-vnext/tools';
import { asJson, iso, isoRequired } from './mappers.ts';
import type { PgTx } from './tx.ts';

interface InvocationRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  principal_id: string;
  conversation_id: string | null;
  execution_id: string | null;
  job_id: string | null;
  plugin_id: string | null;
  tool_id: string;
  tool_version: string;
  status: string;
  arguments: unknown;
  argument_hash: string;
  idempotency_key: string | null;
  attempt_id: string | null;
  attempt_count: number;
  approval_id: string | null;
  result_ref: string | null;
  artefact_ids: unknown;
  file_ids: unknown;
  external_ids: unknown;
  failure_reason: unknown;
  cancel_requested: boolean;
  cancel_confirmed: boolean;
  side_effect_class: string;
  provider: string | null;
  model: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
}

export function createToolStores(tx: PgTx): {
  invocations: ToolInvocationStore;
  approvals: ToolApprovalStore;
} {
  const invocations: ToolInvocationStore = {
    async insert(record) {
      const inserted = await tx.query<InvocationRow>(
        `INSERT INTO tool_invocations (
           id, tenant_id, workspace_id, principal_id, conversation_id, execution_id, job_id, plugin_id,
           tool_id, tool_version, status, arguments, argument_hash, idempotency_key, attempt_id, attempt_count,
           approval_id, result_ref, artefact_ids, file_ids, external_ids, failure_reason, cancel_requested,
           cancel_confirmed, side_effect_class, provider, model, created_at, updated_at, started_at, completed_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb,$21::jsonb,
           $22::jsonb,$23,$24,$25,$26,$27,$28,$29,$30,$31
         ) RETURNING *`,
        params(record),
      );
      return mapInvocation(inserted.rows[0]!);
    },
    async get(tenantId, id) {
      const result = await tx.query<InvocationRow>(
        `SELECT * FROM tool_invocations WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      return result.rows[0] ? mapInvocation(result.rows[0]) : null;
    },
    async save(record, expected) {
      const updated = await tx.query<InvocationRow>(
        `UPDATE tool_invocations SET
           workspace_id = $3, principal_id = $4, conversation_id = $5, execution_id = $6, job_id = $7, plugin_id = $8,
           tool_id = $9, tool_version = $10, status = $11, arguments = $12::jsonb, argument_hash = $13,
           idempotency_key = $14, attempt_id = $15, attempt_count = $16, approval_id = $17, result_ref = $18,
           artefact_ids = $19::jsonb, file_ids = $20::jsonb, external_ids = $21::jsonb, failure_reason = $22::jsonb,
           cancel_requested = $23, cancel_confirmed = $24, side_effect_class = $25, provider = $26, model = $27,
           updated_at = $28, started_at = $29, completed_at = $30
         WHERE id = $1 AND tenant_id = $2 AND ($31::text[] IS NULL OR status = ANY($31))
         RETURNING *`,
        [
          record.id,
          record.tenantId,
          record.workspaceId,
          record.principalId,
          record.conversationId ?? null,
          record.executionId ?? null,
          record.jobId ?? null,
          record.pluginId ?? null,
          record.toolId,
          record.toolVersion,
          record.status,
          JSON.stringify(record.arguments),
          record.argumentHash,
          record.idempotencyKey,
          record.attemptId,
          record.attemptCount,
          record.approvalId ?? null,
          record.resultRef ?? null,
          JSON.stringify(record.artefactIds),
          JSON.stringify(record.fileIds),
          JSON.stringify(record.externalIds),
          record.failureReason ? JSON.stringify(record.failureReason) : null,
          record.cancelRequested,
          record.cancelConfirmed,
          record.sideEffectClass,
          record.provider ?? null,
          record.model ?? null,
          record.updatedAt,
          record.startedAt,
          record.completedAt,
          expected ?? null,
        ],
      );
      if (!updated.rows[0]) throw new Error(`Fail-closed: tool invocation ${record.id} is not visible.`);
      return mapInvocation(updated.rows[0]);
    },
    async findByIdempotency(tenantId, key) {
      const result = await tx.query<InvocationRow>(
        `SELECT * FROM tool_invocations WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, key],
      );
      return result.rows[0] ? mapInvocation(result.rows[0]) : null;
    },
    async listByStatus(tenantId, statuses) {
      const result = tenantId
        ? await tx.query<InvocationRow>(
            `SELECT * FROM tool_invocations WHERE tenant_id = $1 AND status = ANY($2::text[])`,
            [tenantId, statuses],
          )
        : await tx.query<InvocationRow>(`SELECT * FROM tool_invocations WHERE status = ANY($1::text[])`, [statuses]);
      return result.rows.map(mapInvocation);
    },
    async listByConversation(tenantId, conversationId) {
      const result = await tx.query<InvocationRow>(
        `SELECT * FROM tool_invocations WHERE tenant_id = $1 AND conversation_id = $2`,
        [tenantId, conversationId],
      );
      return result.rows.map(mapInvocation);
    },
    async saveResult(tenantId, id, output) {
      await tx.query(
        `INSERT INTO tool_results (invocation_id, tenant_id, output, created_at)
         VALUES ($1, $2, $3::jsonb, now())
         ON CONFLICT (invocation_id) DO UPDATE SET output = EXCLUDED.output`,
        [id, tenantId, JSON.stringify(output)],
      );
    },
    async getResult(tenantId, id) {
      const result = await tx.query<{ output: unknown }>(
        `SELECT output FROM tool_results WHERE invocation_id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      return result.rows[0] ? asJson(result.rows[0].output, {}) : null;
    },
    async saveEffect(tenantId, key, value) {
      const inserted = await tx.query(
        `INSERT INTO tool_effects (tenant_id, effect_key, value, created_at)
         VALUES ($1, $2, $3::jsonb, now())
         ON CONFLICT (tenant_id, effect_key) DO NOTHING
         RETURNING effect_key`,
        [tenantId, key, JSON.stringify(value)],
      );
      return inserted.rows[0] ? 'recorded' : 'replayed';
    },
  };

  const approvals: ToolApprovalStore = {
    async insert(record) {
      await tx.query(
        `INSERT INTO tool_approvals (id, invocation_id, tenant_id, decided_by, decision, reason, expires_at, decided_at, nonce_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          record.id,
          record.invocationId,
          record.tenantId,
          record.decidedBy,
          record.decision,
          record.reason ?? null,
          record.expiresAt,
          record.decidedAt,
          record.nonceHash,
        ],
      );
      return record;
    },
    async get(tenantId, id) {
      const result = await tx.query<ApprovalRow>(
        `SELECT * FROM tool_approvals WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      return result.rows[0] ? mapApproval(result.rows[0]) : null;
    },
    async getByInvocation(tenantId, invocationId) {
      const result = await tx.query<ApprovalRow>(
        `SELECT * FROM tool_approvals WHERE tenant_id = $1 AND invocation_id = $2`,
        [tenantId, invocationId],
      );
      return result.rows[0] ? mapApproval(result.rows[0]) : null;
    },
    async save(record) {
      await tx.query(
        `UPDATE tool_approvals SET decided_by = $3, decision = $4, reason = $5, expires_at = $6, decided_at = $7, nonce_hash = $8
         WHERE id = $1 AND tenant_id = $2`,
        [
          record.id,
          record.tenantId,
          record.decidedBy,
          record.decision,
          record.reason ?? null,
          record.expiresAt,
          record.decidedAt,
          record.nonceHash,
        ],
      );
      return record;
    },
  };

  return { invocations, approvals };
}

interface ApprovalRow {
  id: string;
  invocation_id: string;
  tenant_id: string;
  decided_by: string;
  decision: string;
  reason: string | null;
  expires_at: Date | string | null;
  decided_at: Date | string | null;
  nonce_hash: string;
}

function params(record: ToolInvocation): unknown[] {
  return [
    record.id,
    record.tenantId,
    record.workspaceId,
    record.principalId,
    record.conversationId ?? null,
    record.executionId ?? null,
    record.jobId ?? null,
    record.pluginId ?? null,
    record.toolId,
    record.toolVersion,
    record.status,
    JSON.stringify(record.arguments),
    record.argumentHash,
    record.idempotencyKey,
    record.attemptId,
    record.attemptCount,
    record.approvalId ?? null,
    record.resultRef ?? null,
    JSON.stringify(record.artefactIds),
    JSON.stringify(record.fileIds),
    JSON.stringify(record.externalIds),
    record.failureReason ? JSON.stringify(record.failureReason) : null,
    record.cancelRequested,
    record.cancelConfirmed,
    record.sideEffectClass,
    record.provider ?? null,
    record.model ?? null,
    record.createdAt,
    record.updatedAt,
    record.startedAt,
    record.completedAt,
  ];
}

function mapInvocation(row: InvocationRow): ToolInvocation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    conversationId: row.conversation_id,
    executionId: row.execution_id,
    jobId: row.job_id,
    pluginId: row.plugin_id,
    toolId: row.tool_id,
    toolVersion: row.tool_version,
    status: row.status as ToolInvocationStatus,
    arguments: asJson(row.arguments, {}),
    argumentHash: row.argument_hash,
    idempotencyKey: row.idempotency_key,
    attemptId: row.attempt_id,
    attemptCount: Number(row.attempt_count),
    approvalId: row.approval_id,
    resultRef: row.result_ref,
    artefactIds: asJson(row.artefact_ids, []),
    fileIds: asJson(row.file_ids, []),
    externalIds: asJson(row.external_ids, []),
    failureReason: asJson(row.failure_reason, null),
    cancelRequested: Boolean(row.cancel_requested),
    cancelConfirmed: Boolean(row.cancel_confirmed),
    sideEffectClass: row.side_effect_class as ToolInvocation['sideEffectClass'],
    provider: row.provider,
    model: row.model,
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  };
}

function mapApproval(row: ApprovalRow): ToolApproval {
  return {
    id: row.id,
    invocationId: row.invocation_id,
    tenantId: row.tenant_id,
    decidedBy: row.decided_by,
    decision: row.decision as ToolApproval['decision'],
    reason: row.reason,
    expiresAt: iso(row.expires_at),
    decidedAt: iso(row.decided_at),
    nonceHash: row.nonce_hash,
  };
}

export async function recoverToolInvocations(tx: PgTx, now: string): Promise<{ uncertain: number; failed: number }> {
  const uncertain = await tx.query(
    `UPDATE tool_invocations
     SET status = 'uncertain',
         failure_reason = $1::jsonb,
         updated_at = $2,
         completed_at = $2
     WHERE status = 'running' AND side_effect_class = 'uncertain_external'
     RETURNING id`,
    [
      JSON.stringify({
        code: 'interrupted_uncertain',
        message: 'Interrupted during an uncertain external side effect; not retried.',
        retryable: false,
        at: now,
      }),
      now,
    ],
  );
  const failed = await tx.query(
    `UPDATE tool_invocations
     SET status = 'failed',
         failure_reason = $1::jsonb,
         updated_at = $2,
         completed_at = $2
     WHERE status = 'running' AND side_effect_class <> 'uncertain_external'
     RETURNING id`,
    [
      JSON.stringify({
        code: 'interrupted',
        message: 'Process restarted before the tool finished.',
        retryable: true,
        at: now,
      }),
      now,
    ],
  );
  return { uncertain: uncertain.rowCount ?? 0, failed: failed.rowCount ?? 0 };
}
