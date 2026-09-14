-- Schema v2: artefact metadata stubs (CAS pointers only) and event retention hooks.

CREATE TABLE IF NOT EXISTS artefact_metadata (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  workspace_id TEXT REFERENCES workspaces (id),
  content_hash TEXT,
  mime_type TEXT,
  size_bytes BIGINT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS artefact_metadata_tenant_idx ON artefact_metadata (tenant_id);

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS retained_until TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS event_retention_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants (id),
  stream_id TEXT,
  max_entries INTEGER NOT NULL,
  max_age_seconds INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS events_retained_until_idx ON events (retained_until)
  WHERE retained_until IS NOT NULL;
