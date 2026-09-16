-- Dungeon estate records, owner-only privacy policy, and durable audit.
-- Dungeons remain thin: identity/metadata live here; blobs stay in CAS.

CREATE TABLE IF NOT EXISTS dungeon_records (
  id TEXT PRIMARY KEY,
  urn TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  workspace_id TEXT REFERENCES workspaces (id),
  dungeon TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  artefact_id TEXT,
  content_hash TEXT,
  job_id TEXT,
  conversation_id TEXT,
  parent_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  failure JSONB,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS dungeon_records_workspace_idx
  ON dungeon_records (tenant_id, workspace_id, dungeon, kind);
CREATE INDEX IF NOT EXISTS dungeon_records_parent_idx
  ON dungeon_records (parent_id);
CREATE INDEX IF NOT EXISTS dungeon_records_status_idx
  ON dungeon_records (status);

CREATE TABLE IF NOT EXISTS privacy_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  dungeon_id TEXT,
  payload JSONB NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS privacy_policies_tenant_default
  ON privacy_policies (tenant_id) WHERE dungeon_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS privacy_policies_tenant_dungeon
  ON privacy_policies (tenant_id, dungeon_id) WHERE dungeon_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS privacy_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  capability TEXT NOT NULL,
  resource TEXT,
  decision TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  before JSONB,
  after JSONB,
  step_up BOOLEAN NOT NULL DEFAULT FALSE,
  at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS privacy_audit_tenant_idx ON privacy_audit (tenant_id, at DESC);

CREATE TABLE IF NOT EXISTS privacy_proposals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  proposed_by TEXT NOT NULL,
  dungeon_id TEXT,
  patch JSONB NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);
