-- Tools, auth sessions, memberships, Authority grants, secret refs, audit.
-- Additive. No blobs. No secret values.

CREATE TABLE IF NOT EXISTS tenant_memberships (
  principal_id TEXT NOT NULL REFERENCES principals (id),
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  role TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (principal_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS workspace_memberships (
  principal_id TEXT NOT NULL REFERENCES principals (id),
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  role TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (principal_id, tenant_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals (id),
  tenant_id TEXT REFERENCES tenants (id),
  csrf_secret TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL,
  user_agent_hash TEXT
);

CREATE INDEX IF NOT EXISTS sessions_principal_idx ON sessions (principal_id);

CREATE TABLE IF NOT EXISTS authority_grants (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  capability TEXT NOT NULL,
  workspace_id TEXT,
  resource_type TEXT,
  resource_id TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS authority_grants_principal_idx
  ON authority_grants (tenant_id, principal_id);

CREATE TABLE IF NOT EXISTS tool_invocations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  workspace_id TEXT,
  principal_id TEXT NOT NULL,
  conversation_id TEXT,
  execution_id TEXT,
  job_id TEXT,
  plugin_id TEXT,
  tool_id TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  status TEXT NOT NULL,
  arguments JSONB NOT NULL,
  argument_hash TEXT NOT NULL,
  idempotency_key TEXT,
  attempt_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  approval_id TEXT,
  result_ref TEXT,
  artefact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  file_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  external_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  failure_reason JSONB,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  cancel_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  side_effect_class TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS tool_invocations_tenant_idempotency_idx
  ON tool_invocations (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS tool_invocations_tenant_status_idx
  ON tool_invocations (tenant_id, status);

CREATE TABLE IF NOT EXISTS tool_results (
  invocation_id TEXT PRIMARY KEY REFERENCES tool_invocations (id),
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  output JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_effects (
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  effect_key TEXT NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, effect_key)
);

CREATE TABLE IF NOT EXISTS tool_approvals (
  id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES tool_invocations (id),
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  decided_by TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  expires_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  nonce_hash TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS tool_approvals_invocation_idx
  ON tool_approvals (tenant_id, invocation_id);

CREATE TABLE IF NOT EXISTS plugin_records (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  tool_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  secret_names JSONB NOT NULL DEFAULT '[]'::jsonb,
  rate_limit_per_minute INTEGER,
  external_binding TEXT
);

CREATE TABLE IF NOT EXISTS secret_refs (
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  rotated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  principal_id TEXT,
  workspace_id TEXT,
  action TEXT NOT NULL,
  capability TEXT,
  decision TEXT,
  reason_code TEXT,
  resource_type TEXT,
  resource_id_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_tenant_idx ON audit_events (tenant_id, created_at DESC);
