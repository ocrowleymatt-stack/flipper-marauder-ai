-- Atlas vNext persistence schema v1
-- Additive only. Never DROP SCHEMA / DROP DATABASE from migrations.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  urn TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  urn TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  urn TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  name TEXT NOT NULL,
  dungeon TEXT,
  root_manifest_hash TEXT,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS workspaces_tenant_idx ON workspaces (tenant_id);

CREATE TABLE IF NOT EXISTS behaviour_postures (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants (id),
  behaviour TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by_tenant_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  urn TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  workspace_id TEXT REFERENCES workspaces (id),
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS conversations_tenant_idempotency_idx
  ON conversations (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS conversations_tenant_updated_idx
  ON conversations (tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  urn TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  conversation_id TEXT NOT NULL REFERENCES conversations (id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  execution_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (conversation_id, sequence)
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, sequence);

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  urn TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  conversation_id TEXT NOT NULL REFERENCES conversations (id),
  user_message_id TEXT NOT NULL,
  assistant_message_id TEXT,
  status TEXT NOT NULL,
  capability TEXT NOT NULL,
  route JSONB,
  selected_provider TEXT,
  selected_model TEXT,
  attempts JSONB NOT NULL DEFAULT '[]'::jsonb,
  usage JSONB,
  failure_reason JSONB,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS executions_conversation_idx ON executions (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS executions_inflight_idx ON executions (status) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  workspace_id TEXT REFERENCES workspaces (id),
  project_id TEXT,
  dungeon TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  current_stage TEXT,
  progress_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
  checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  idempotency_key TEXT,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  trace_id TEXT NOT NULL,
  failure_reason JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_tenant_idempotency_idx
  ON jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs (tenant_id, status, priority DESC, created_at);

CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs (lease_owner, lease_until);

CREATE TABLE IF NOT EXISTS job_checkpoints (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  job_id TEXT NOT NULL REFERENCES jobs (id),
  stage TEXT NOT NULL,
  progress_ratio DOUBLE PRECISION NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS job_checkpoints_job_idx ON job_checkpoints (job_id, created_at);

CREATE TABLE IF NOT EXISTS event_streams (
  stream_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  next_seq BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  workspace_id TEXT,
  conversation_id TEXT,
  job_id TEXT,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (stream_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS events_tenant_idempotency_idx
  ON events (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_stream_seq_idx ON events (stream_id, seq);
CREATE INDEX IF NOT EXISTS events_tenant_idx ON events (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS runtime_leases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  resource_key TEXT NOT NULL,
  owner TEXT,
  lease_until TIMESTAMPTZ,
  status TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, resource_key)
);

CREATE TABLE IF NOT EXISTS provenance (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  artefact_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source_inputs JSONB NOT NULL,
  input_manifest_hash TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
  job_id TEXT,
  timestamp TIMESTAMPTZ NOT NULL,
  trace_id TEXT NOT NULL,
  capability TEXT,
  usage JSONB,
  locality TEXT,
  latency_ms INTEGER,
  selected_route_id TEXT,
  attempt_outcomes JSONB,
  artefact_hash TEXT
);

CREATE INDEX IF NOT EXISTS provenance_job_idx ON provenance (job_id);
CREATE INDEX IF NOT EXISTS provenance_tenant_idx ON provenance (tenant_id);
