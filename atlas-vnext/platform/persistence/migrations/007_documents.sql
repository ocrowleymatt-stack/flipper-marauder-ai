-- Durable project-scoped documents. Identity lives here; blobs stay in CAS.
-- Optimistic concurrency via revision. Versions are append-only.

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  urn TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  current_content_hash TEXT,
  draft_content_hash TEXT,
  current_artefact_id TEXT,
  draft_artefact_id TEXT,
  conversation_id TEXT,
  originating_run_id TEXT,
  failure JSONB,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS documents_workspace_idx ON documents (tenant_id, workspace_id);
CREATE INDEX IF NOT EXISTS documents_status_idx ON documents (status);

CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents (id),
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  artefact_id TEXT NOT NULL,
  title TEXT NOT NULL,
  operation TEXT NOT NULL,
  execution_id TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (document_id, version)
);

CREATE INDEX IF NOT EXISTS document_versions_document_idx ON document_versions (document_id, version);
