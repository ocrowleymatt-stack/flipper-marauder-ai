# Writing model

Caspa is the first real Atlas dungeon: a thin writing domain over platform projects, CAS, context, Nexus, Execution, Authority, and Workbench. Historical Caspa/Shakespeare product trees remain behavioural references, not templates.

## One project, many documents

A writing work lives in **one** `platform/projects` record. Documents are project children (tenant + project). Conversation is a run spine. The document + versions are authoritative.

## Rules

1. **No parallel writing databases.** Caspa PostgreSQL revisions, Shakespeare local state, commons literary stores, and AM writing folders collapse into `platform/projects` + CAS + `documents` / `document_versions`.
2. Do not port Caspa product UI, GoldPipeline, or Caspa routers.
3. Kept via contracts/behaviour: immutable version conflict (`stale_revision` / `VERSION_CONFLICT`), craft rules as composed Behaviour, selected-file grounding.
4. Long-running commissions remain `platform/jobs` (deferred). This slice uses the conversation/execution spine for a writing run.
5. Writing must not import OSINT or investigation dungeons; retrieval goes through `platform/context`.

See [CASPA-WRITING.md](./CASPA-WRITING.md).
