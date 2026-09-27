-- Atlas Case Intelligence Store
-- PostgreSQL is authoritative; imported SQLite/CSV/JSONL files are evidence inputs only.

CREATE TABLE IF NOT EXISTS intelligence_cases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intelligence_cases_tenant_workspace_idx ON intelligence_cases(tenant_id, workspace_id);

CREATE TABLE IF NOT EXISTS intelligence_sources (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  case_id uuid REFERENCES intelligence_cases(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  title text NOT NULL,
  content_hash text,
  external_ref text,
  captured_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intelligence_sources_case_idx ON intelligence_sources(tenant_id, workspace_id, case_id);
CREATE INDEX IF NOT EXISTS intelligence_sources_hash_idx ON intelligence_sources(content_hash);

CREATE TABLE IF NOT EXISTS intelligence_entities (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  case_id uuid REFERENCES intelligence_cases(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  canonical_label text NOT NULL,
  canonical_value text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intelligence_entities_lookup_idx ON intelligence_entities(tenant_id, workspace_id, entity_type, canonical_value);
CREATE INDEX IF NOT EXISTS intelligence_entities_label_idx ON intelligence_entities USING gin (to_tsvector('simple', canonical_label));

CREATE TABLE IF NOT EXISTS intelligence_observations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  case_id uuid REFERENCES intelligence_cases(id) ON DELETE CASCADE,
  source_id uuid REFERENCES intelligence_sources(id) ON DELETE SET NULL,
  entity_id uuid REFERENCES intelligence_entities(id) ON DELETE SET NULL,
  observation_type text NOT NULL,
  observed_value text NOT NULL,
  source_locator jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz,
  confidence text NOT NULL DEFAULT 'source_fact',
  raw_context text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intelligence_observations_entity_idx ON intelligence_observations(entity_id);
CREATE INDEX IF NOT EXISTS intelligence_observations_case_idx ON intelligence_observations(tenant_id, workspace_id, case_id);
CREATE INDEX IF NOT EXISTS intelligence_observations_text_idx ON intelligence_observations USING gin (to_tsvector('simple', coalesce(observed_value,'') || ' ' || coalesce(raw_context,'')));

CREATE TABLE IF NOT EXISTS intelligence_relationships (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  case_id uuid REFERENCES intelligence_cases(id) ON DELETE CASCADE,
  subject_entity_id uuid NOT NULL REFERENCES intelligence_entities(id) ON DELETE CASCADE,
  predicate text NOT NULL,
  object_entity_id uuid NOT NULL REFERENCES intelligence_entities(id) ON DELETE CASCADE,
  source_id uuid REFERENCES intelligence_sources(id) ON DELETE SET NULL,
  confidence text NOT NULL DEFAULT 'possible',
  status text NOT NULL DEFAULT 'active',
  rationale text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intelligence_relationships_subject_idx ON intelligence_relationships(subject_entity_id);
CREATE INDEX IF NOT EXISTS intelligence_relationships_object_idx ON intelligence_relationships(object_entity_id);

CREATE TABLE IF NOT EXISTS intelligence_assertions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  case_id uuid REFERENCES intelligence_cases(id) ON DELETE CASCADE,
  proposition text NOT NULL,
  assertion_class text NOT NULL DEFAULT 'claim',
  asserted_by_entity_id uuid REFERENCES intelligence_entities(id) ON DELETE SET NULL,
  source_id uuid REFERENCES intelligence_sources(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'unresolved',
  confidence text NOT NULL DEFAULT 'possible',
  source_locator jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intelligence_assertions_case_idx ON intelligence_assertions(tenant_id, workspace_id, case_id);
CREATE INDEX IF NOT EXISTS intelligence_assertions_text_idx ON intelligence_assertions USING gin (to_tsvector('english', proposition));

CREATE TABLE IF NOT EXISTS intelligence_assertion_evidence (
  assertion_id uuid NOT NULL REFERENCES intelligence_assertions(id) ON DELETE CASCADE,
  observation_id uuid NOT NULL REFERENCES intelligence_observations(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation IN ('supports','contradicts','contextualises')),
  note text,
  PRIMARY KEY(assertion_id, observation_id, relation)
);

CREATE TABLE IF NOT EXISTS intelligence_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  case_id uuid REFERENCES intelligence_cases(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  title text NOT NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  location_entity_id uuid REFERENCES intelligence_entities(id) ON DELETE SET NULL,
  source_id uuid REFERENCES intelligence_sources(id) ON DELETE SET NULL,
  description text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intelligence_events_time_idx ON intelligence_events(case_id, starts_at);

CREATE TABLE IF NOT EXISTS intelligence_event_entities (
  event_id uuid NOT NULL REFERENCES intelligence_events(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES intelligence_entities(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'mentioned',
  PRIMARY KEY(event_id, entity_id, role)
);

CREATE TABLE IF NOT EXISTS intelligence_enrichments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  entity_id uuid NOT NULL REFERENCES intelligence_entities(id) ON DELETE CASCADE,
  provider text NOT NULL,
  query_value text NOT NULL,
  result jsonb NOT NULL,
  result_hash text,
  confidence text NOT NULL DEFAULT 'provider_reported',
  queried_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  cost_minor_units integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS intelligence_enrichments_entity_provider_idx ON intelligence_enrichments(entity_id, provider, queried_at DESC);

-- Never collapse provenance: aliases and alternate values are observations/entities, not destructive updates.
