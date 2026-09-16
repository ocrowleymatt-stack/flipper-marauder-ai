import { randomUUID } from 'node:crypto';
import type { DungeonId, DungeonRecordStatus, StructuredFailure } from '@atlas-vnext/contracts';
import { logPlatform } from '@atlas-vnext/observability';
import { assertActor, type PersistenceActor } from '../actor.ts';
import { ConflictError, OwnershipError } from '../errors.ts';
import type {
  DungeonRecordRow,
  DungeonRecordStore,
  PrivacyAuditRow,
  PrivacyPolicyRow,
  PrivacyProposalRow,
  PrivacyStore,
} from '../dungeon-types.ts';
import { asJson, isoRequired, sqlRow } from './mappers.ts';
import type { PgTx } from './tx.ts';

interface RecordRow {
  id: string;
  urn: string;
  tenant_id: string;
  workspace_id: string | null;
  dungeon: string;
  kind: string;
  title: string;
  status: string;
  payload: unknown;
  artefact_id: string | null;
  content_hash: string | null;
  job_id: string | null;
  conversation_id: string | null;
  parent_id: string | null;
  revision: number;
  failure: unknown;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
}

interface PolicyRow {
  id: string;
  tenant_id: string;
  dungeon_id: string | null;
  payload: unknown;
  revision: number;
  updated_by: string;
  updated_at: Date | string;
}

interface AuditRow {
  id: string;
  tenant_id: string;
  actor_id: string;
  action: string;
  capability: string;
  resource: string | null;
  decision: string;
  reason_code: string;
  before: unknown;
  after: unknown;
  step_up: boolean;
  at: Date | string;
}

interface ProposalRow {
  id: string;
  tenant_id: string;
  proposed_by: string;
  dungeon_id: string | null;
  patch: unknown;
  status: string;
  decided_by: string | null;
  decided_at: Date | string | null;
  created_at: Date | string;
}

function mapRecord(row: RecordRow): DungeonRecordRow {
  return {
    id: row.id,
    urn: row.urn,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    dungeon: row.dungeon as DungeonId,
    kind: row.kind,
    title: row.title,
    status: row.status as DungeonRecordStatus,
    payload: asJson<Record<string, unknown>>(row.payload, {}),
    artefactId: row.artefact_id,
    contentHash: row.content_hash,
    jobId: row.job_id,
    conversationId: row.conversation_id,
    parentId: row.parent_id,
    revision: Number(row.revision),
    failure: asJson<StructuredFailure | null>(row.failure, null),
    createdBy: row.created_by,
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
    deletedAt: row.deleted_at ? isoRequired(row.deleted_at) : null,
  };
}

function mapPolicy(row: PolicyRow): PrivacyPolicyRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    dungeonId: (row.dungeon_id as DungeonId | null) ?? null,
    payload: asJson<Record<string, unknown>>(row.payload, {}),
    revision: Number(row.revision),
    updatedBy: row.updated_by,
    updatedAt: isoRequired(row.updated_at),
  };
}

function mapAudit(row: AuditRow): PrivacyAuditRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    action: row.action,
    capability: row.capability,
    resource: row.resource,
    decision: row.decision,
    reasonCode: row.reason_code,
    before: asJson<Record<string, unknown> | null>(row.before, null),
    after: asJson<Record<string, unknown> | null>(row.after, null),
    stepUp: Boolean(row.step_up),
    at: isoRequired(row.at),
  };
}

function mapProposal(row: ProposalRow): PrivacyProposalRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    proposedBy: row.proposed_by,
    dungeonId: (row.dungeon_id as DungeonId | null) ?? null,
    patch: asJson<Record<string, unknown>>(row.patch, {}),
    status: row.status as PrivacyProposalRow['status'],
    decidedBy: row.decided_by,
    decidedAt: row.decided_at ? isoRequired(row.decided_at) : null,
    createdAt: isoRequired(row.created_at),
  };
}

export function createDungeonRecordStore(tx: PgTx, clock: () => string): DungeonRecordStore {
  return {
    async create(actor, input) {
      const scoped = assertActor(actor, 'create dungeon record');
      const now = clock();
      const id = input.id ?? `drec_${randomUUID()}`;
      const result = await tx.query<RecordRow>(
        `INSERT INTO dungeon_records (
           id, urn, tenant_id, workspace_id, dungeon, kind, title, status, payload,
           artefact_id, content_hash, job_id, conversation_id, parent_id, revision,
           failure, created_by, created_at, updated_at, deleted_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,1,NULL,$15,$16,$16,NULL)
         RETURNING *`,
        [
          id,
          `urn:atlas:${input.dungeon}:${id}`,
          scoped.tenantId,
          input.workspaceId ?? null,
          input.dungeon,
          input.kind,
          input.title,
          input.status ?? 'idle',
          JSON.stringify(input.payload ?? {}),
          input.artefactId ?? null,
          input.contentHash ?? null,
          input.jobId ?? null,
          input.conversationId ?? null,
          input.parentId ?? null,
          scoped.principalId ?? null,
          now,
        ],
      );
      return mapRecord(sqlRow(result.rows[0]!));
    },
    async get(actor, id) {
      const scoped = assertActor(actor, 'read dungeon record');
      const result = await tx.query<RecordRow>(
        'SELECT * FROM dungeon_records WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
        [id, scoped.tenantId],
      );
      const row = result.rows[0];
      if (!row) return null;
      if (scoped.workspaceId && row.workspace_id && row.workspace_id !== scoped.workspaceId) return null;
      return mapRecord(sqlRow(row));
    },
    async list(actor, input) {
      const scoped = assertActor(actor, 'list dungeon records');
      const result = await tx.query<RecordRow>(
        `SELECT * FROM dungeon_records
         WHERE tenant_id = $1 AND dungeon = $2 AND deleted_at IS NULL
           AND ($3::text IS NULL OR workspace_id IS NOT DISTINCT FROM $3)
           AND ($4::text IS NULL OR kind = $4)
           AND ($5::text IS NULL OR parent_id IS NOT DISTINCT FROM $5)
         ORDER BY updated_at DESC`,
        [scoped.tenantId, input.dungeon, input.workspaceId ?? null, input.kind ?? null, input.parentId ?? null],
      );
      return result.rows
        .map((row) => mapRecord(sqlRow(row)))
        .filter((item) => !scoped.workspaceId || !item.workspaceId || item.workspaceId === scoped.workspaceId);
    },
    async update(actor, id, patch) {
      const scoped = assertActor(actor, 'update dungeon record');
      return tx.run(async () => {
        const loaded = await tx.query<RecordRow>(
          'SELECT * FROM dungeon_records WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE',
          [id, scoped.tenantId],
        );
        const current = loaded.rows[0];
        if (!current || (scoped.workspaceId && current.workspace_id && current.workspace_id !== scoped.workspaceId)) {
          logPlatform('ownership.rejected', { action: 'update dungeon record', tenantId: scoped.tenantId, id });
          throw new OwnershipError(`Fail-closed: record ${id} is not visible to tenant ${scoped.tenantId}.`);
        }
        if (Number(current.revision) !== patch.expectedRevision) {
          throw new ConflictError(`Record ${id} revision ${patch.expectedRevision} does not match ${current.revision}.`);
        }
        const result = await tx.query<RecordRow>(
          `UPDATE dungeon_records SET
             title = COALESCE($3, title),
             status = COALESCE($4, status),
             payload = COALESCE($5::jsonb, payload),
             artefact_id = COALESCE($6, artefact_id),
             content_hash = COALESCE($7, content_hash),
             job_id = COALESCE($8, job_id),
             conversation_id = COALESCE($9, conversation_id),
             failure = COALESCE($10::jsonb, failure),
             revision = revision + 1,
             updated_at = $11
           WHERE id = $1 AND tenant_id = $2 AND revision = $12
           RETURNING *`,
          [
            id,
            scoped.tenantId,
            patch.title ?? null,
            patch.status ?? null,
            patch.payload ? JSON.stringify(patch.payload) : null,
            patch.artefactId === undefined ? null : patch.artefactId,
            patch.contentHash === undefined ? null : patch.contentHash,
            patch.jobId === undefined ? null : patch.jobId,
            patch.conversationId === undefined ? null : patch.conversationId,
            patch.failure === undefined ? null : JSON.stringify(patch.failure),
            clock(),
            patch.expectedRevision,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new ConflictError(`Record ${id} was updated concurrently.`);
        return mapRecord(sqlRow(row));
      });
    },
    async logicalDelete(actor, id, expectedRevision) {
      const scoped = assertActor(actor, 'delete dungeon record');
      return tx.run(async () => {
        const loaded = await tx.query<RecordRow>(
          'SELECT * FROM dungeon_records WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE',
          [id, scoped.tenantId],
        );
        const current = loaded.rows[0];
        if (!current) throw new OwnershipError(`Fail-closed: record ${id} is not visible.`);
        if (expectedRevision != null && Number(current.revision) !== expectedRevision) {
          throw new ConflictError(`Record ${id} revision ${expectedRevision} does not match ${current.revision}.`);
        }
        const result = await tx.query<RecordRow>(
          `UPDATE dungeon_records SET deleted_at = $3, revision = revision + 1, updated_at = $3
           WHERE id = $1 AND tenant_id = $2 RETURNING *`,
          [id, scoped.tenantId, clock()],
        );
        return mapRecord(sqlRow(result.rows[0]!));
      });
    },
  };
}

export function createPrivacyStore(tx: PgTx, clock: () => string): PrivacyStore {
  return {
    async getPolicy(actor, dungeonId) {
      const scoped = assertActor(actor, 'read privacy policy');
      const result = await tx.query<PolicyRow>(
        'SELECT * FROM privacy_policies WHERE tenant_id = $1 AND dungeon_id IS NOT DISTINCT FROM $2',
        [scoped.tenantId, dungeonId],
      );
      const row = result.rows[0];
      return row ? mapPolicy(sqlRow(row)) : null;
    },
    async listPolicies(actor) {
      const scoped = assertActor(actor, 'list privacy policies');
      const result = await tx.query<PolicyRow>('SELECT * FROM privacy_policies WHERE tenant_id = $1', [scoped.tenantId]);
      return result.rows.map((row) => mapPolicy(sqlRow(row)));
    },
    async upsertPolicy(actor, input) {
      const scoped = assertActor(actor, 'write privacy policy');
      const current = await tx.query<PolicyRow>(
        'SELECT * FROM privacy_policies WHERE tenant_id = $1 AND dungeon_id IS NOT DISTINCT FROM $2 FOR UPDATE',
        [scoped.tenantId, input.dungeonId],
      );
      const existing = current.rows[0];
      if (existing && input.expectedRevision != null && Number(existing.revision) !== input.expectedRevision) {
        throw new ConflictError(`Policy revision ${input.expectedRevision} does not match ${existing.revision}.`);
      }
      const now = clock();
      if (!existing) {
        const inserted = await tx.query<PolicyRow>(
          `INSERT INTO privacy_policies (id, tenant_id, dungeon_id, payload, revision, updated_by, updated_at)
           VALUES ($1,$2,$3,$4::jsonb,1,$5,$6) RETURNING *`,
          [`pol_${randomUUID()}`, scoped.tenantId, input.dungeonId, JSON.stringify(input.payload), input.updatedBy, now],
        );
        return mapPolicy(sqlRow(inserted.rows[0]!));
      }
      const updated = await tx.query<PolicyRow>(
        `UPDATE privacy_policies SET payload = $3::jsonb, revision = revision + 1, updated_by = $4, updated_at = $5
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [existing.id, scoped.tenantId, JSON.stringify(input.payload), input.updatedBy, now],
      );
      return mapPolicy(sqlRow(updated.rows[0]!));
    },
    async appendAudit(actor, row) {
      const scoped = assertActor(actor, 'append privacy audit');
      const inserted = await tx.query<AuditRow>(
        `INSERT INTO privacy_audit (
           id, tenant_id, actor_id, action, capability, resource, decision, reason_code, before, after, step_up, at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)
         RETURNING *`,
        [
          row.id ?? `aud_${randomUUID()}`,
          scoped.tenantId,
          row.actorId,
          row.action,
          row.capability,
          row.resource,
          row.decision,
          row.reasonCode,
          row.before ? JSON.stringify(row.before) : null,
          row.after ? JSON.stringify(row.after) : null,
          row.stepUp,
          row.at ?? clock(),
        ],
      );
      return mapAudit(sqlRow(inserted.rows[0]!));
    },
    async listAudit(actor, limit = 100) {
      const scoped = assertActor(actor, 'list privacy audit');
      const result = await tx.query<AuditRow>(
        'SELECT * FROM privacy_audit WHERE tenant_id = $1 ORDER BY at DESC LIMIT $2',
        [scoped.tenantId, limit],
      );
      return result.rows.map((row) => mapAudit(sqlRow(row)));
    },
    async createProposal(actor, input) {
      const scoped = assertActor(actor, 'create privacy proposal');
      const inserted = await tx.query<ProposalRow>(
        `INSERT INTO privacy_proposals (id, tenant_id, proposed_by, dungeon_id, patch, status, decided_by, decided_at, created_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,'proposed',NULL,NULL,$6) RETURNING *`,
        [`prop_${randomUUID()}`, scoped.tenantId, input.proposedBy, input.dungeonId, JSON.stringify(input.patch), clock()],
      );
      return mapProposal(sqlRow(inserted.rows[0]!));
    },
    async listProposals(actor) {
      const scoped = assertActor(actor, 'list privacy proposals');
      const result = await tx.query<ProposalRow>(
        'SELECT * FROM privacy_proposals WHERE tenant_id = $1 ORDER BY created_at DESC',
        [scoped.tenantId],
      );
      return result.rows.map((row) => mapProposal(sqlRow(row)));
    },
    async decideProposal(actor, id, input) {
      const scoped = assertActor(actor, 'decide privacy proposal');
      const loaded = await tx.query<ProposalRow>(
        'SELECT * FROM privacy_proposals WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [id, scoped.tenantId],
      );
      const current = loaded.rows[0];
      if (!current) throw new OwnershipError(`Fail-closed: proposal ${id} is not visible.`);
      if (current.status !== 'proposed') throw new ConflictError(`Proposal ${id} is already ${current.status}.`);
      const updated = await tx.query<ProposalRow>(
        `UPDATE privacy_proposals SET status = $3, decided_by = $4, decided_at = $5
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [id, scoped.tenantId, input.status, input.decidedBy, clock()],
      );
      return mapProposal(sqlRow(updated.rows[0]!));
    },
  };
}
