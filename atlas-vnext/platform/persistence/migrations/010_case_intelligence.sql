-- Atlas vNext shared intelligence data plane
-- Canonical Atlas tenant/workspace IDs are TEXT. Intelligence augments workspaces;
-- it does not create a parallel tenancy, project, file, or provenance universe.

CREATE TABLE IF NOT EXISTS intelligence_cases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX IF NOT EXISTS intelligence_cases_scope_idx ON intelligence_cases(tenant_id, workspace_id);

-- Sources point at canonical Atlas artefacts/CAS where available. external_ref remains
-- for web/API evidence which has not yet been materialised into an artefact.
CREATE TABLE IF NOT EXISTS intelligence_sources (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  case_id TEXT REFERENCES intelligence_cases(id) ON DELETE CASCADE,
  artefact_id TEXT REFERENCES artefacts(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content_hash TEXT,
  external_ref TEXT,
  captured_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, case_id, source_type, content_hash, external_ref)
);
CREATE INDEX IF NOT EXISTS intelligence_sources_scope_idx ON intelligence_sources(tenant_id, workspace_id, case_id);
CREATE INDEX IF NOT EXISTS intelligence_sources_hash_idx ON intelligence_sources(content_hash);

-- Entities are canonical workspace knowledge objects. Cases refer to them through
-- observations/assertions/events; deleting one case must never delete shared knowledge.
CREATE TABLE IF NOT EXISTS intelligence_entities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  entity_type TEXT NOT NULL,
  canonical_label TEXT NOT NULL,
  canonical_value TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS intelligence_entities_value_uq
  ON intelligence_entities(tenant_id, workspace_id, entity_type, canonical_value)
  WHERE canonical_value IS NOT NULL;
CREATE INDEX IF NOT EXISTS intelligence_entities_label_idx
  ON intelligence_entities USING gin (to_tsvector('simple', canonical_label));

CREATE TABLE IF NOT EXISTS intelligence_observations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  case_id TEXT REFERENCES intelligence_cases(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES intelligence_sources(id) ON DELETE SET NULL,
  entity_id TEXT REFERENCES intelligence_entities(id) ON DELETE SET NULL,
  observation_type TEXT NOT NULL,
  observed_value TEXT NOT NULL,
  source_locator JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ,
  epistemic_class TEXT NOT NULL DEFAULT 'source_fact'
    CHECK (epistemic_class IN ('source_fact','reported_claim','derived','inference','disputed','corroborated')),
  confidence TEXT,
  raw_context TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intelligence_observations_scope_idx ON intelligence_observations(tenant_id, workspace_id, case_id);
CREATE INDEX IF NOT EXISTS intelligence_observations_entity_idx ON intelligence_observations(entity_id);
CREATE UNIQUE INDEX IF NOT EXISTS intelligence_observations_import_uq
  ON intelligence_observations(tenant_id, workspace_id, case_id, source_id, entity_id, observation_type, observed_value, md5(source_locator::text));

CREATE TABLE IF NOT EXISTS intelligence_relationships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  case_id TEXT REFERENCES intelligence_cases(id) ON DELETE CASCADE,
  subject_entity_id TEXT NOT NULL REFERENCES intelligence_entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,
  object_entity_id TEXT NOT NULL REFERENCES intelligence_entities(id) ON DELETE CASCADE,
  epistemic_class TEXT NOT NULL DEFAULT 'inference',
  confidence TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  rationale TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intelligence_relationships_scope_idx ON intelligence_relationships(tenant_id, workspace_id, case_id);

CREATE TABLE IF NOT EXISTS intelligence_assertions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  case_id TEXT REFERENCES intelligence_cases(id) ON DELETE CASCADE,
  proposition TEXT NOT NULL,
  assertion_class TEXT NOT NULL DEFAULT 'claim',
  asserted_by_entity_id TEXT REFERENCES intelligence_entities(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'unresolved',
  epistemic_class TEXT NOT NULL DEFAULT 'reported_claim',
  confidence TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intelligence_assertions_scope_idx ON intelligence_assertions(tenant_id, workspace_id, case_id);

-- Generic evidence edges let observations support/contradict/contextualise both
-- assertions and relationships without collapsing provenance to one source column.
CREATE TABLE IF NOT EXISTS intelligence_evidence_edges (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  observation_id TEXT NOT NULL REFERENCES intelligence_observations(id) ON DELETE CASCADE,
  assertion_id TEXT REFERENCES intelligence_assertions(id) ON DELETE CASCADE,
  relationship_id TEXT REFERENCES intelligence_relationships(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('supports','contradicts','contextualises')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((assertion_id IS NOT NULL)::int + (relationship_id IS NOT NULL)::int = 1),
  UNIQUE(observation_id, assertion_id, relationship_id, relation)
);

CREATE TABLE IF NOT EXISTS intelligence_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  case_id TEXT REFERENCES intelligence_cases(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  location_entity_id TEXT REFERENCES intelligence_entities(id) ON DELETE SET NULL,
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intelligence_events_time_idx ON intelligence_events(tenant_id, workspace_id, case_id, starts_at);

CREATE TABLE IF NOT EXISTS intelligence_event_entities (
  event_id TEXT NOT NULL REFERENCES intelligence_events(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES intelligence_entities(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'mentioned',
  PRIMARY KEY(event_id, entity_id, role)
);

-- Enrichment rows are immutable execution observations, never mutable entity state.
CREATE TABLE IF NOT EXISTS intelligence_enrichments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  entity_id TEXT NOT NULL REFERENCES intelligence_entities(id) ON DELETE CASCADE,
  execution_id TEXT REFERENCES executions(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  tool_version TEXT,
  query_value TEXT NOT NULL,
  result JSONB NOT NULL,
  result_hash TEXT,
  confidence TEXT NOT NULL DEFAULT 'provider_reported',
  queried_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  cost_minor_units INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(tenant_id, workspace_id, entity_id, provider, query_value, result_hash)
);
CREATE INDEX IF NOT EXISTS intelligence_enrichments_entity_provider_idx
  ON intelligence_enrichments(entity_id, provider, queried_at DESC);
