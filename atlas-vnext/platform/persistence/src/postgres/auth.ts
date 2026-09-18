import type { SessionRecord, TenantMembership, WorkspaceMembership } from '@atlas-vnext/contracts';
import type { CredentialStore, DirectoryStore, PrincipalCredential, SessionStore } from '@atlas-vnext/auth';
import { iso, isoRequired, asJson } from './mappers.ts';
import type { PgTx } from './tx.ts';

export function createAuthStores(tx: PgTx): {
  sessions: SessionStore;
  directory: DirectoryStore;
  credentials: CredentialStore;
} {
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

  const credentials: CredentialStore = {
    async getByLogin(loginIdNormalized) {
      const result = await tx.query<CredentialRow>(
        `SELECT * FROM principal_credentials WHERE login_id_normalized = $1`,
        [loginIdNormalized],
      );
      return result.rows[0] ? mapCredential(result.rows[0]) : null;
    },
    async getByPrincipal(principalId) {
      const result = await tx.query<CredentialRow>(`SELECT * FROM principal_credentials WHERE principal_id = $1`, [
        principalId,
      ]);
      return result.rows[0] ? mapCredential(result.rows[0]) : null;
    },
    async put(record) {
      await tx.query(
        `INSERT INTO principal_credentials (
           principal_id, login_id, login_id_normalized, password_hash, password_algo, created_at, updated_at, rotated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (principal_id) DO UPDATE SET
           login_id = EXCLUDED.login_id,
           login_id_normalized = EXCLUDED.login_id_normalized,
           password_hash = EXCLUDED.password_hash,
           password_algo = EXCLUDED.password_algo,
           updated_at = EXCLUDED.updated_at,
           rotated_at = EXCLUDED.rotated_at`,
        [
          record.principalId,
          record.loginId,
          record.loginIdNormalized,
          record.passwordHash,
          record.passwordAlgo,
          record.createdAt,
          record.updatedAt,
          record.rotatedAt,
        ],
      );
      return record;
    },
  };

  return { sessions, directory, credentials };
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

interface CredentialRow {
  principal_id: string;
  login_id: string;
  login_id_normalized: string;
  password_hash: string;
  password_algo: string;
  created_at: Date | string;
  updated_at: Date | string;
  rotated_at: Date | string;
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

function mapCredential(row: CredentialRow): PrincipalCredential {
  return {
    principalId: row.principal_id,
    loginId: row.login_id,
    loginIdNormalized: row.login_id_normalized,
    passwordHash: row.password_hash,
    passwordAlgo: row.password_algo,
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
    rotatedAt: isoRequired(row.rotated_at),
  };
}
