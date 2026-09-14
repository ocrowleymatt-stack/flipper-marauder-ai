-- Schema v4: files, CAS refs, extractions, chunks, attachments.
-- Additive. Never DROP SCHEMA / DROP DATABASE. No file bytes / BYTEA blobs.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS workspaces_tenant_active_idx
  ON workspaces (tenant_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS cas_objects (
  sha256 TEXT PRIMARY KEY,
  size_bytes BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS cas_refs (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL REFERENCES cas_objects (sha256),
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  workspace_id TEXT REFERENCES workspaces (id),
  kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (sha256, kind, owner_id)
);

CREATE INDEX IF NOT EXISTS cas_refs_tenant_idx ON cas_refs (tenant_id, sha256);
CREATE INDEX IF NOT EXISTS cas_refs_hash_idx ON cas_refs (sha256);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  urn TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  artefact_id TEXT REFERENCES artefact_metadata (id),
  created_by TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS files_workspace_path_active_idx
  ON files (tenant_id, workspace_id, path)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS files_workspace_idx ON files (tenant_id, workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS files_hash_idx ON files (tenant_id, content_hash);

CREATE TABLE IF NOT EXISTS file_versions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files (id),
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (file_id, version)
);

CREATE INDEX IF NOT EXISTS file_versions_file_idx ON file_versions (file_id, version);

CREATE TABLE IF NOT EXISTS extractions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  file_id TEXT REFERENCES files (id),
  content_hash TEXT NOT NULL,
  extractor TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  status TEXT NOT NULL,
  page_count INTEGER,
  structure JSONB NOT NULL DEFAULT '{}'::jsonb,
  text_hash TEXT,
  error JSONB,
  job_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS extractions_tenant_hash_extractor_idx
  ON extractions (tenant_id, content_hash, extractor, extractor_version);

CREATE INDEX IF NOT EXISTS extractions_file_idx ON extractions (file_id);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  file_id TEXT NOT NULL REFERENCES files (id),
  content_hash TEXT NOT NULL,
  chunker TEXT NOT NULL,
  chunker_version TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  locator JSONB NOT NULL,
  text TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  UNIQUE (tenant_id, file_id, chunker, chunker_version, ordinal)
);

CREATE INDEX IF NOT EXISTS chunks_workspace_idx ON chunks (tenant_id, workspace_id);
CREATE INDEX IF NOT EXISTS chunks_file_idx ON chunks (file_id);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING GIN (tsv);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  workspace_id TEXT REFERENCES workspaces (id),
  conversation_id TEXT NOT NULL REFERENCES conversations (id),
  message_id TEXT REFERENCES messages (id),
  file_id TEXT NOT NULL REFERENCES files (id),
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  detached_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS attachments_conversation_idx
  ON attachments (tenant_id, conversation_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS attachments_active_unique_idx
  ON attachments (tenant_id, conversation_id, file_id)
  WHERE detached_at IS NULL;
