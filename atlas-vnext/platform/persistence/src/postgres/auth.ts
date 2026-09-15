import type { SessionRecord, TenantMembership, WorkspaceMembership } from '@atlas-vnext/contracts';
import type { DirectoryStore, SessionStore } from '@atlas-vnext/auth';
import { iso, isoRequired, asJson } from './mappers.ts';
import type { PgTx } from './tx.ts';

export function createAuthStores(tx: PgTx): { sessions: SessionStore; directory: DirectoryStore } {
  const sessions: SessionStore = {
    async insert(record) {
      await tx.query(
        `INSERT INTO sessions (id, principal_id, tenant_id, csrf_secret, created_at, expires_at, rotated_at, revoked_at, last_seen_at, user_agent_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          record.id,
          record.principalId,
          record.tenantId,
          record.csrfSecret,
          record.createdAt,
          record.expiresAt,
          record.rotatedAt ?? null,
          record.revokedAt,
          record.lastSeenAt,
          record.userAgentHash ?? null,
        ],
      );
      return record;
    },
    async get(id) {
      const result = await tx.query<SessionRow>(`SELECT * FROM sessions WHERE id = $1`, [id]);
      return result.rows[0] ? mapSession(result.rows[0]) : null;
    },
    async save(record) {
      await tx.query(
        `UPDATE sessions SET principal_id = $2, tenant_id = $3, csrf_secret = $4, expires_at = $5, rotated_at = $6,
           revoked_at = $7, last_seen_at = $8, user_agent_hash = $9
         WHERE id = $1`,
        [
          record.id,
          record.principalId,
          record.tenantId,
          record.csrfSecret,
          record.expiresAt,
          record.rotatedAt ?? null,
          record.revokedAt,
          record.lastSeenAt,
          record.userAgentHash ?? null,
        ],
      );
      return record;
    },
    async listByPrincipal(principalId) {
      const result = await tx.query<SessionRow>(`SELECT * FROM sessions WHERE principal_id = $1`, [principalId]);
      return result.rows.map(mapSession);
    },
  };

  const directory: DirectoryStore = {
    async getTenantMembership(principalId, tenantId) {
      const result = await tx.query<TenantMemRow>(
        `SELECT * FROM tenant_memberships WHERE principal_id = $1 AND tenant_id = $2`,
        [principalId, tenantId],
      );
      return result.rows[0] ? mapTenantMem(result.rows[0]) : null;
    },
    async listTenantMemberships(principalId) {
      const result = await tx.query<TenantMemRow>(`SELECT * FROM tenant_memberships WHERE principal_id = $1`, [
        principalId,
      ]);
      return result.rows.map(mapTenantMem);
    },
    async getWorkspaceMembership(principalId, tenantId, workspaceId) {
      const result = await tx.query<WorkspaceMemRow>(
        `SELECT * FROM workspace_memberships WHERE principal_id = $1 AND tenant_id = $2 AND workspace_id = $3`,
        [principalId, tenantId, workspaceId],
      );
      return result.rows[0] ? mapWorkspaceMem(result.rows[0]) : null;
    },
    async putTenantMembership(row) {
      await tx.query(
        `INSERT INTO tenant_memberships (principal_id, tenant_id, role, capabilities, created_at)
         VALUES ($1,$2,$3,$4::jsonb,$5)
         ON CONFLICT (principal_id, tenant_id) DO UPDATE SET role = EXCLUDED.role, capabilities = EXCLUDED.capabilities`,
        [row.principalId, row.tenantId, row.role, JSON.stringify(row.capabilities), row.createdAt],
      );
      return row;
    },
    async putWorkspaceMembership(row) {
      await tx.query(
        `INSERT INTO workspace_memberships (principal_id, tenant_id, workspace_id, role, capabilities, created_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)
         ON CONFLICT (principal_id, tenant_id, workspace_id) DO UPDATE SET role = EXCLUDED.role, capabilities = EXCLUDED.capabilities`,
        [row.principalId, row.tenantId, row.workspaceId, row.role, JSON.stringify(row.capabilities), row.createdAt],
      );
      return row;
    },
  };

  return { sessions, directory };
}

interface SessionRow {
  id: string;
  principal_id: string;
  tenant_id: string | null;
  csrf_secret: string;
  created_at: Date | string;
  expires_at: Date | string;
  rotated_at: Date | string | null;
  revoked_at: Date | string | null;
  last_seen_at: Date | string;
  user_agent_hash: string | null;
}

interface TenantMemRow {
  principal_id: string;
  tenant_id: string;
  role: string;
  capabilities: unknown;
  created_at: Date | string;
}

interface WorkspaceMemRow extends TenantMemRow {
  workspace_id: string;
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    principalId: row.principal_id,
    tenantId: row.tenant_id,
    csrfSecret: row.csrf_secret,
    createdAt: isoRequired(row.created_at),
    expiresAt: isoRequired(row.expires_at),
    rotatedAt: iso(row.rotated_at),
    revokedAt: iso(row.revoked_at),
    lastSeenAt: isoRequired(row.last_seen_at),
    userAgentHash: row.user_agent_hash,
  };
}

function mapTenantMem(row: TenantMemRow): TenantMembership {
  return {
    principalId: row.principal_id,
    tenantId: row.tenant_id,
    role: row.role,
    capabilities: asJson(row.capabilities, []),
    createdAt: isoRequired(row.created_at),
  };
}

function mapWorkspaceMem(row: WorkspaceMemRow): WorkspaceMembership {
  return {
    ...mapTenantMem(row),
    workspaceId: row.workspace_id,
  };
}
