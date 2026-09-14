# Persistence

Implemented architecture, schema, migrations, jobs, events, tenancy, and local/CI/production config: [platform/persistence/README.md](../platform/persistence/README.md).

This tranche is durability and recovery. It is not Files/CAS, Workbench UI, Dungeon migration, Caspa, or a Mountain UI clone.

## Product direction (constraint, not implementation)

Atlas vNext UX will be a **progressive Workbench**, substantially better than Mountain, not a UI clone and not a linear-chat product. Persistence must keep that possible. Do not implement the Workbench UI here.

The schema already supports, without prematurely implementing:

| Later product surface | Persistence already has |
|---|---|
| Persistent Projects / workspaces | Tenant-scoped `workspaces` rows (manifest hash pointer). First-class named Project objects come later. |
| Conversations belonging to workspaces | `conversations.workspace_id` (optional). Chat is one workspace child, not the only one. |
| First-class durable artefacts | `artefact_metadata` (identity, tenant/workspace, type, version/parent, creator/execution/job, `content_hash`). Not every result is chat text. |
| Resumable long-running work | `jobs`, `job_checkpoints`, `job_attempts` (leases, retry, cancel). Conversation `executions` are chat-turn records only. |
| Versioned documents / artefacts | `artefact_metadata.version` + `parent_id` lineage. |
| Files, sources, provenance | Provenance stubs + hash pointers. Blobs stay out of PostgreSQL (Files/CAS gated). |
| Contextual workbench surfaces | Events and metadata are workspace/job/artefact addressable, not chat-stream-only. |
| Future Dungeons as thin product shells | Shared platform capabilities (jobs, artefacts, workspaces, events). No dungeon-owned databases. |

Rules this tranche must not violate:

- Chat is **one surface**: simple tasks can stay in conversation; substantial work uses persistent workspace/artefact surfaces later.
- Do **not** treat messages as the only durable result.
- Do **not** add schema that requires every artefact to be a message.
- Do **not** document conversations as the only workspace child.
- Do **not** copy Mountain UI architecture into persistence or the host.
- UI is out of this tranche.

Deferred: Files/CAS blobs, retrieval, Tools, Dungeon migration, Caspa, production cutover, replacing the RunPod file runtime store, Workbench UI.
