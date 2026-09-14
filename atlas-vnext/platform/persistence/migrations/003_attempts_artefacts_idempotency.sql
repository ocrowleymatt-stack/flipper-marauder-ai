-- Schema v3: job attempts, artefact-ready metadata, DB idempotency, tenant-scoped event streams.
-- Additive. Never DROP SCHEMA / DROP DATABASE. No blobs.

CREATE TABLE IF NOT EXISTS job_attempts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  job_id TEXT NOT NULL REFERENCES jobs (id),
  attempt_number INTEGER NOT NULL,
  worker_id TEXT,
  outcome TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  failure_reason JSONB,
  UNIQUE (job_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS job_attempts_job_idx ON job_attempts (tenant_id, job_id, attempt_number);
CREATE INDEX IF NOT EXISTS job_attempts_tenant_idx ON job_attempts (tenant_id);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS messages_tenant_idempotency_idx
  ON messages (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE executions
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS executions_tenant_idempotency_idx
  ON executions (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS executions_conversation_user_message_idx
  ON executions (conversation_id, user_message_id);

ALTER TABLE job_checkpoints
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS job_checkpoints_tenant_idempotency_idx
  ON job_checkpoints (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE artefact_metadata
  ADD COLUMN IF NOT EXISTS urn TEXT,
  ADD COLUMN IF NOT EXISTS type TEXT,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS parent_id TEXT REFERENCES artefact_metadata (id),
  ADD COLUMN IF NOT EXISTS created_by TEXT,
  ADD COLUMN IF NOT EXISTS execution_id TEXT,
  ADD COLUMN IF NOT EXISTS job_id TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE artefact_metadata SET urn = 'urn:atlas:artefact:' || id WHERE urn IS NULL;
UPDATE artefact_metadata SET updated_at = created_at WHERE updated_at IS NULL;

ALTER TABLE artefact_metadata ALTER COLUMN updated_at SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS artefact_metadata_urn_idx ON artefact_metadata (urn);
CREATE INDEX IF NOT EXISTS artefact_metadata_parent_idx ON artefact_metadata (parent_id);
CREATE INDEX IF NOT EXISTS artefact_metadata_workspace_idx ON artefact_metadata (tenant_id, workspace_id);

-- Tenants may independently use the same channel name.
ALTER TABLE event_streams DROP CONSTRAINT IF EXISTS event_streams_pkey;
ALTER TABLE event_streams ADD PRIMARY KEY (tenant_id, stream_id);

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_stream_id_seq_key;
CREATE UNIQUE INDEX IF NOT EXISTS events_tenant_stream_seq_idx
  ON events (tenant_id, stream_id, seq);

ALTER TABLE behaviour_postures DROP CONSTRAINT IF EXISTS behaviour_postures_mode_check;
ALTER TABLE behaviour_postures
  ADD CONSTRAINT behaviour_postures_mode_check CHECK (behaviour IN ('standard', 'open'));
