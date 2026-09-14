import { randomUUID } from 'node:crypto';
import { DEFAULT_BEHAVIOUR_MODE, behaviourModeSchema, type BehaviourMode, type TenantBehaviourRecord } from '@atlas-vnext/contracts';
import { BehaviourPolicyError, TenantIsolationError } from '@atlas-vnext/permissions';
import { UuidIdFactory } from '@atlas-vnext/conversation';
import { logPlatform } from '@atlas-vnext/observability';
import { ConflictError, OwnershipError } from '../errors.ts';
import { assertActor, type PersistenceActor } from '../actor.ts';
import type { DurableBehaviourStore, PrincipalRecord, TenantRecord, WorkspaceRecord, WorkspaceStore } from '../kernel.ts';
import { mapPrincipal, mapTenant, mapWorkspace, sqlRow } from './mappers.ts';
import type { PgTx } from './tx.ts';

const ids = new UuidIdFactory();

export async function ensureTenant(tx: PgTx, input: { id: string; name: string }, now = new Date().toISOString()): Promise<TenantRecord> {
  if (!input.id.trim()) throw new OwnershipError('Fail-closed: tenant id is required.');
  const existing = await tx.query('SELECT * FROM tenants WHERE id = $1', [input.id]);
  if (existing.rows[0]) return mapTenant(sqlRow(existing.rows[0]));
  const inserted = await tx.query(
    `INSERT INTO tenants (id, urn, name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [input.id, `urn:atlas:tenant:${input.id}`, input.name, now],
  );
  return mapTenant(sqlRow(inserted.rows[0]!));
}

export async function ensurePrincipal(
  tx: PgTx,
  input: { id: string; displayName?: string | null },
  now = new Date().toISOString(),
): Promise<PrincipalRecord> {
  if (!input.id.trim()) throw new OwnershipError('Fail-closed: principal id is required.');
  const inserted = await tx.query(
    `INSERT INTO principals (id, urn, display_name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (id) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, principals.display_name), updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [input.id, `urn:atlas:principal:${input.id}`, input.displayName ?? null, now],
  );
  return mapPrincipal(sqlRow(inserted.rows[0]!));
}

export function createWorkspaceStore(tx: PgTx): WorkspaceStore {
  const store: WorkspaceStore = {
    async create(actor, input) {
      const scoped = assertActor(actor, 'create workspace');
      await ensureTenant(tx, { id: scoped.tenantId, name: scoped.tenantId });
      const now = new Date().toISOString();
      const id = input.id ?? `wks_${randomUUID()}`;
      const inserted = await tx.query(
        `INSERT INTO workspaces (
           id, urn, tenant_id, name, description, dungeon, root_manifest_hash, archived, revision, deleted_at, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, NULL, FALSE, 1, NULL, $7, $7)
         RETURNING *`,
        [
          id,
          ids.urn('conversation', id).replace(':conversation:', ':workspace:'),
          scoped.tenantId,
          input.name,
          input.description ?? null,
          input.dungeon ?? null,
          now,
        ],
      );
      return mapWorkspace(sqlRow(inserted.rows[0]!));
    },
    async get(actor, id, opts) {
      const scoped = assertActor(actor, 'read workspace');
      const result = await tx.query(`SELECT * FROM workspaces WHERE id = $1 AND tenant_id = $2`, [id, scoped.tenantId]);
      const row = result.rows[0];
      if (!row) return null;
      if (scoped.workspaceId && scoped.workspaceId !== row.id) return null;
      const mapped = mapWorkspace(sqlRow(row));
      if (mapped.deletedAt && !opts?.includeDeleted) return null;
      return mapped;
    },
    async list(actor, opts) {
      const scoped = assertActor(actor, 'list workspaces');
      const clauses = ['tenant_id = $1'];
      const params: unknown[] = [scoped.tenantId];
      if (scoped.workspaceId) {
        clauses.push(`id = $${params.length + 1}`);
        params.push(scoped.workspaceId);
      }
      if (!opts?.includeDeleted) clauses.push('deleted_at IS NULL');
      if (!opts?.includeArchived) clauses.push('archived = FALSE');
      const result = await tx.query(
        `SELECT * FROM workspaces WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC`,
        params,
      );
      return result.rows.map((row) => mapWorkspace(sqlRow(row)));
    },
    async update(actor, id, patch) {
      const scoped = assertActor(actor, 'update workspace');
      const now = new Date().toISOString();
      const result = await tx.query(
        `UPDATE workspaces SET
           name = COALESCE($4, name),
           description = COALESCE($5, description),
           dungeon = COALESCE($6, dungeon),
           revision = revision + 1,
           updated_at = $7
         WHERE id = $1 AND tenant_id = $2 AND revision = $3 AND deleted_at IS NULL
         RETURNING *`,
        [id, scoped.tenantId, patch.expectedRevision, patch.name ?? null, patch.description ?? null, patch.dungeon ?? null, now],
      );
      if (!result.rows[0]) {
        const existing = await store.get(actor, id, { includeDeleted: true });
        if (!existing) {
          throw new OwnershipError(`Fail-closed: workspace ${id} is not visible to tenant ${scoped.tenantId}.`);
        }
        throw new ConflictError(
          `Workspace ${id} revision ${patch.expectedRevision} does not match ${existing.revision}.`,
        );
      }
      return mapWorkspace(sqlRow(result.rows[0]));
    },
    async archive(actor, id, expectedRevision) {
      return mutateFlag(actor, id, expectedRevision, true, 'archive workspace');
    },
    async restore(actor, id, expectedRevision) {
      return mutateFlag(actor, id, expectedRevision, false, 'restore workspace');
    },
    async logicalDelete(actor, id, expectedRevision) {
      const scoped = assertActor(actor, 'delete workspace');
      const now = new Date().toISOString();
      const revisionClause = expectedRevision == null ? '' : ' AND revision = $4';
      const params: unknown[] = [id, scoped.tenantId, now];
      if (expectedRevision != null) params.push(expectedRevision);
      const result = await tx.query(
        `UPDATE workspaces SET deleted_at = $3, archived = TRUE, revision = revision + 1, updated_at = $3
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL${revisionClause}
         RETURNING *`,
        params,
      );
      if (!result.rows[0]) {
        throw new OwnershipError(`Fail-closed: workspace ${id} is not visible to tenant ${scoped.tenantId}.`);
      }
      return mapWorkspace(sqlRow(result.rows[0]));
    },
    async bindManifest(actor, id, manifestHash) {
      const scoped = assertActor(actor, 'bind workspace manifest');
      const result = await tx.query(
        `UPDATE workspaces SET root_manifest_hash = $3, updated_at = $4, revision = revision + 1
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         RETURNING *`,
        [id, scoped.tenantId, manifestHash, new Date().toISOString()],
      );
      if (!result.rows[0]) {
        logPlatform('ownership.rejected', { action: 'bindManifest', tenantId: scoped.tenantId, workspaceId: id });
        throw new OwnershipError(`Fail-closed: workspace ${id} is not visible to tenant ${scoped.tenantId}.`);
      }
      return mapWorkspace(sqlRow(result.rows[0]));
    },
  };

  async function mutateFlag(
    actor: PersistenceActor,
    id: string,
    expectedRevision: number | undefined,
    archived: boolean,
    action: string,
  ) {
    const scoped = assertActor(actor, action);
    const now = new Date().toISOString();
    const revisionClause = expectedRevision == null ? '' : ' AND revision = $4';
    const params: unknown[] = [id, scoped.tenantId, archived, now];
    if (expectedRevision != null) params.push(expectedRevision);
    const result = await tx.query(
      `UPDATE workspaces SET archived = $3, revision = revision + 1, updated_at = $4
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL${revisionClause}
       RETURNING *`,
      params,
    );
    if (!result.rows[0]) {
      const existing = await store.get(actor, id, { includeDeleted: true });
      if (!existing) throw new OwnershipError(`Fail-closed: workspace ${id} is not visible to tenant ${scoped.tenantId}.`);
      throw new ConflictError(`Workspace ${id} could not be updated (revision conflict or deleted).`);
    }
    return mapWorkspace(sqlRow(result.rows[0]));
  }

  return store;
}

export function createBehaviourStore(tx: PgTx): DurableBehaviourStore {
  return {
    async resolve(actorTenantId, subjectTenantId = actorTenantId) {
      assertBehaviourTenant(actorTenantId, subjectTenantId, 'resolve');
      const result = await tx.query('SELECT * FROM behaviour_postures WHERE tenant_id = $1', [subjectTenantId]);
      const row = result.rows[0] as { behaviour?: string } | undefined;
      if (!row) return DEFAULT_BEHAVIOUR_MODE;
      return parseBehaviour(row.behaviour);
    },
    async read(actorTenantId, subjectTenantId) {
      assertBehaviourTenant(actorTenantId, subjectTenantId, 'read');
      const result = await tx.query('SELECT * FROM behaviour_postures WHERE tenant_id = $1', [subjectTenantId]);
      const row = result.rows[0] as
        | { tenant_id: string; behaviour: string; updated_at: Date | string; updated_by_tenant_id: string }
        | undefined;
      if (!row) return null;
      return {
        tenantId: row.tenant_id,
        behaviour: parseBehaviour(row.behaviour),
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
        updatedByTenantId: row.updated_by_tenant_id,
      } satisfies TenantBehaviourRecord;
    },
    async write(actorTenantId, subjectTenantId, behaviour) {
      assertBehaviourTenant(actorTenantId, subjectTenantId, 'write');
      await ensureTenant(tx, { id: subjectTenantId, name: subjectTenantId });
      const parsed = parseBehaviour(behaviour);
      const now = new Date().toISOString();
      const result = await tx.query(
        `INSERT INTO behaviour_postures (tenant_id, behaviour, updated_at, updated_by_tenant_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id) DO UPDATE SET behaviour = EXCLUDED.behaviour, updated_at = EXCLUDED.updated_at, updated_by_tenant_id = EXCLUDED.updated_by_tenant_id
         RETURNING *`,
        [subjectTenantId, parsed, now, actorTenantId],
      );
      const row = result.rows[0]!;
      return {
        tenantId: row.tenant_id as string,
        behaviour: parseBehaviour(row.behaviour),
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
        updatedByTenantId: row.updated_by_tenant_id as string,
      };
    },
  };
}

function parseBehaviour(value: unknown): BehaviourMode {
  const parsed = behaviourModeSchema.safeParse(value);
  if (!parsed.success) {
    throw new BehaviourPolicyError(`Fail-closed: invalid Behaviour mode ${String(value)}.`);
  }
  return parsed.data;
}

function assertBehaviourTenant(actorTenantId: string, subjectTenantId: string, action: string): void {
  if (!actorTenantId.trim()) {
    throw new TenantIsolationError(`Fail-closed: cannot ${action} Behaviour without a tenant id.`);
  }
  if (!subjectTenantId.trim() || actorTenantId !== subjectTenantId) {
    logPlatform('ownership.rejected', { action: `behaviour.${action}`, actorTenantId, subjectTenantId });
    throw new TenantIsolationError(
      `Fail-closed: tenant ${actorTenantId} cannot ${action} Behaviour for tenant ${subjectTenantId}.`,
    );
  }
}

export type { BehaviourMode };
