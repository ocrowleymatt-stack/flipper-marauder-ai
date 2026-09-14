# Persistence

Implemented architecture, schema, migrations, jobs, events, tenancy, and local/CI/production config: [platform/persistence/README.md](../platform/persistence/README.md).

This tranche is durability and recovery plus the Files/CAS/context foundation. It is not Workbench UI, Dungeon migration, Caspa, or a Mountain UI clone.

## Product direction (constraint, not implementation)

Atlas vNext UX will be a **progressive Workbench**, substantially better than Mountain, not a UI clone and not a linear-chat product. Persistence must keep that possible. Do not implement the Workbench UI here.

The schema already supports, without prematurely implementing:

| Later product surface | Persistence already has |
|---|---|
| Persistent Projects / workspaces | Tenant-scoped `workspaces` + first-class `ProjectService` |
| Conversations belonging to workspaces | `conversations.workspace_id` (optional). Chat is one workspace child, not the only one. |
| First-class durable artefacts | `artefact_metadata` (identity, tenant/workspace, type, version/parent, creator/execution/job, `content_hash`). Not every result is chat text. |
| Resumable long-running work | `jobs`, `job_checkpoints`, `job_attempts` (leases, retry, cancel). Conversation `executions` are chat-turn records only. |
| Versioned documents / artefacts | `artefact_metadata.version` + `parent_id` lineage + CAS content. |
| Files, sources, provenance | CAS blobs + `files` / chunks / attachments + provenance rows. |
| Generated sites / versioned website trees | `site_records` current-revision pointer + CAS-backed `site_revisions` (not copied `site-v2` trees). |
| Contextual workbench surfaces | `ContextService` assembles source-backed slices with citations. UI is not in this tranche. |
| Future Dungeons as thin product shells | Shared platform capabilities (jobs, artefacts, workspaces, files, events). No dungeon-owned databases. |

Rules this tranche must not violate:

- Chat is **one surface**: simple tasks can stay in conversation; substantial work uses persistent workspace/artefact surfaces later.
- Do **not** treat messages as the only durable result.
- Do **not** add schema that requires every artefact to be a message.
- Do **not** document conversations as the only workspace child.
- Do **not** copy Mountain UI architecture into persistence or the host.
- UI is out of this tranche.

Deferred: Tools, Dungeon migration, Caspa, production cutover, replacing the RunPod file runtime store, Workbench UI, OCR, embeddings as the primary retriever.

See [FILES-AND-CONTEXT.md](./FILES-AND-CONTEXT.md).
