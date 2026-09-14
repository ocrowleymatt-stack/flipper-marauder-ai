-- Schema v5: logical sites with a current-revision pointer and bounded history.
-- Additive. Never DROP SCHEMA / DROP DATABASE. No file bytes / BYTEA blobs.
-- Revisions are manifests (hash lists), not copied directory trees (no site-v2 copies).

CREATE TABLE IF NOT EXISTS site_records (
  id TEXT PRIMARY KEY,
  urn TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  name TEXT NOT NULL,
  current_revision_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS site_records_workspace_name_active_idx
  ON site_records (tenant_id, workspace_id, name)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS site_records_workspace_idx
  ON site_records (tenant_id, workspace_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS site_revisions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES site_records (id),
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  artefact_id TEXT REFERENCES artefact_metadata (id),
  parent_id TEXT,
  version INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL,
  retention_class TEXT NOT NULL,
  pin_reason TEXT,
  retained_until TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (site_id, version)
);

CREATE INDEX IF NOT EXISTS site_revisions_site_idx
  ON site_revisions (site_id, version DESC);

CREATE INDEX IF NOT EXISTS site_revisions_retained_idx
  ON site_revisions (tenant_id, retention_class)
  WHERE expired_at IS NULL;

CREATE TABLE IF NOT EXISTS site_revision_entries (
  revision_id TEXT NOT NULL REFERENCES site_revisions (id),
  path TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  content_hash TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  PRIMARY KEY (revision_id, path)
);

CREATE INDEX IF NOT EXISTS site_revision_entries_hash_idx
  ON site_revision_entries (content_hash);
