# Persistence

PostgreSQL is the production-capable metadata store. Conversation ports, the job engine, and the event bus stay adapter-free; `platform/persistence` owns SQL, pools, and migrations.

This tranche is durability, restart safety, transactional correctness, tenant/workspace isolation, and the Files/CAS/context foundation. It is not Dungeon migration, Caspa, Nexus/Execution redesign, Workbench UI, or a Mountain UI clone.

Product direction (constraint, not UI work): Atlas vNext is a progressive Workbench — simple chat when the task is simple; persistent workspace/artefact surfaces when work is substantial. Chat is one surface. Messages are not the only durable result. Conversations belong to workspaces; they are not the only workspace child. First-class Project objects are `ProjectService` over `workspaces`. See [docs/PERSISTENCE.md](../../docs/PERSISTENCE.md) and [docs/FILES-AND-CONTEXT.md](../../docs/FILES-AND-CONTEXT.md).

## Inventory (pre-change)

| Surface | Before this tranche | After |
|---|---|---|
| Conversations / messages / executions | JSON `FileDocument` + in-memory maps | Same ports; PostgreSQL + memory kernels |
| Jobs | Transition table only | Restart-safe engine + `SELECT … FOR UPDATE SKIP LOCKED` |
| Events | In-process `MemoryEventBus` / file log | Durable per-stream seq, replay, idempotent append |
| Projects / workspaces | Interface stub | Tenant-scoped workspace rows + first-class `ProjectService`. Conversations, jobs, files, and artefacts may belong to a workspace; conversations are not the only child. |
| Artefact metadata / provenance | Interface stubs | Versioned `artefact_metadata` + provenance rows (hashes only). Durable results are not required to be chat messages. |
| Files / CAS / context | Design-gate shells | Filesystem CAS, ingestion, extraction, chunking, lexical retrieval, budgeted context, citations. |
| Behaviour posture | In-process `TenantBehaviourStore` | Durable per-tenant row; still not Authority |
| Runtime leases | RunPod file store (unchanged) | Optional PG `runtime_leases` metadata; scheduler semantics unchanged |
| JSON file store | Local/dev conversation document | Still local/dev; not a second production architecture |

## Architecture

- **Nexus owns WHERE. Execution owns HOW.** Persistence does not route or call providers.
- Domain packages (`conversation`, `jobs`, `events`, `permissions`) define ports. PostgreSQL details live under `platform/persistence/src/postgres/`.
- Production mode is PostgreSQL. In-memory implements the **same** `PlatformPersistence` contracts for unit tests. Integration tests use a real PostgreSQL adapter.
- Requesting PostgreSQL and failing to connect **fails closed**. There is no silent fallback to memory or the JSON file.
- Blobs are not stored in PostgreSQL. `artefact_metadata` and `files` store identity + tenant/workspace + type + version/parent lineage + timestamps + `content_hash` (CAS pointer). Chunk rows hold bounded retrieval text, not uploaded files.

```text
apps/host  →  ConversationRuntime (current simple-chat surface; not the product shell)
           →  PlatformPersistence.forActor(tenant)
                ├ workspaces          (durable container; first-class Projects later)
                ├ conversations / messages / executions
                │                     (one workspace child; chat-turn records only)
                ├ jobs / checkpoints / attempts
                │                     (resumable long-running work; not chat-bound)
                ├ artefact_metadata   (first-class durable results; hash pointer only)
                ├ files / chunks / attachments
                ├ cas_objects / cas_refs (refcount; bytes stay in CAS)
                ├ provenance          (artefact lineage; not a second chat log)
                ├ events              (per-stream seq + replay; conversation or job)
                ├ behaviour
                └ runtime_leases      (metadata only)
```

Do not add tables or docs that force every artefact through `messages`, or that treat the conversation list as the workspace.

## Schema ownership

Tables (see `platform/persistence/migrations/`):

- `schema_migrations` — version, name, checksum
- `principals`, `tenants`, `workspaces`
- `behaviour_postures`
- `conversations`, `messages`, `executions`
- `jobs`, `job_checkpoints`, `job_attempts`
- `event_streams`, `events`
- `runtime_leases`
- `provenance`, `artefact_metadata` (hashes/metadata only; no blobs)
- `cas_objects`, `cas_refs`, `files`, `file_versions`, `extractions`, `chunks`, `attachments`

IDs are opaque strings (`cnv_…`, `job_…`). Ownership is `(tenant_id)` plus optional `workspace_id`. Looking up by ID without a tenant fails closed.

## Migrations

1. Ordered `001_*.sql`, `002_*.sql`, … (contiguous versions).
2. Startup runs `migrate()`: create `schema_migrations` if needed, apply pending files in a transaction, record checksum.
3. Applied files are never re-executed. Checksum mismatch **fails startup**.
4. Failed SQL rolls back that migration and throws `MigrationError`. Data already committed is left intact; the bad version is not recorded.
5. Migrations are additive. They must not `DROP SCHEMA` / `DROP DATABASE` or recreate the world.

Empty database: apply 001 then 002. Repeat startup: both skipped.

Upgrade fixture: apply frozen v1 SQL + `schema_migrations` row 1, then run the migrator (applies 002).

## Transaction boundaries

`PlatformPersistence.run()` is the unit of work (PostgreSQL `BEGIN/COMMIT`, nested calls reuse the connection via `AsyncLocalStorage`).

Atomic today:

- conversation create + `conversation.created`
- user message + execution create + those events (conversation runtime)
- first assistant message + execution `assistantMessageId`
- job enqueue / claim / checkpoint / complete / fail / cancel + job events

No distributed transactions. CAS put happens before the metadata transaction; unreferenced blobs are GC'd by hook.

Idempotency keys (unique per tenant; retries return the committed row, including after a racing second connection):

- conversation create `(tenant_id, idempotency_key)`
- message append `(tenant_id, idempotency_key)`
- execution create `(conversation_id, user_message_id)` and execution id
- job enqueue `(tenant_id, idempotency_key)`
- job checkpoint `(tenant_id, idempotency_key)`
- event append `(tenant_id, idempotency_key)`

Terminal job `complete` / `fail` / `cancel` and terminal execution `save` are idempotent. Repeating them does not emit a second completion event.

## Durable jobs

State machine remains `JOB_TRANSITIONS` in `platform/jobs`. Engine: `createJobEngine(store)`.

- `queued` rows survive restart.
- Claim: `FOR UPDATE SKIP LOCKED` (Postgres) or an in-process mutex (memory). Two workers cannot run the same job.
- Each claim writes a `job_attempts` row (`started` → `succeeded` / `failed` / `lease_expired` / `released`).
- Heartbeat refreshes `lease_until`. Expired `running` leases re-queue (retry) or fail (retries exhausted).
- `waiting_runtime` is **not** claimed and **not** converted by lease recovery (RunPod scarce-runtime wait stays durable).
- Terminal `completed` / `cancelled` are immutable except explicit `recoverTerminal` (admin).
- `cancel` is durable (`cancel_requested` + terminal status); cancelled jobs are not claimed.

## Event replay

Each stream (`conversation:<id>`, `job:<id>`) has a monotonic `seq` on `event_streams`. Live SSE still fans out in-process **after** commit. Reconnect: `replay(channel, { eventId | seq })`. Committed events do not depend on the process staying alive.

Retention: `applyEventRetention(maxEntries)` deletes oldest **non-held** rows per stream (hook; not a product GC job). Required conversation/job completion events set `retained_until` and are not pruned. Conversations, messages, jobs, checkpoints, artefacts, and provenance rows are never deleted by this hook.

## Restart / recovery

On host start with PostgreSQL:

1. Migrate (fail visible).
2. `recoverOnStart()`: in-flight conversation executions (`queued`/`running`) → `failed` / `interrupted`; expired job leases reconciled; expired `runtime_leases` marked expired; `waiting_runtime` left alone. Scheduler still owns the one paid RunPod — persistence does not start pods.
3. Fresh service objects against the same database reconstruct snapshots. No duplicate assistant messages; no lost committed events.

JSON file mode still uses `ConversationRuntime.recoverInFlight()` (existing local/dev behaviour).

## Tenant / workspace isolation

Authoritative checks are in the adapter, not the UI.

- Missing/blank tenant → `OwnershipError` / `TenantIsolationError`.
- Tenant A cannot read/mutate B conversations, jobs, events, or Behaviour.
- Workspace-scoped actors cannot use another workspace’s conversation id.
- Behaviour posture is per-tenant; invalid modes fail closed; Open still does not grant Authority.
- Artefact metadata and provenance are tenant-scoped. Looking up by id without the owning tenant returns null.
- No process-global tenant cache; each call carries the actor.

## Local development

```bash
# JSON file (default when NODE_ENV is not production)
ATLAS_VNEXT_DATA=.data/state.json npm start

# PostgreSQL (required for production)
export ATLAS_PERSISTENCE=postgres
export ATLAS_DATABASE_URL=postgres://atlas:atlas@127.0.0.1:5432/atlas_vnext
export ATLAS_TENANT_ID=tenant_local
npm start
```

Also accepted: `DATABASE_URL`. Pool: `ATLAS_DB_POOL_MAX`, `ATLAS_DB_IDLE_TIMEOUT_MS`, `ATLAS_DB_CONNECT_TIMEOUT_MS`, `ATLAS_DB_STATEMENT_TIMEOUT_MS`.

`NODE_ENV=production` without PostgreSQL throws at config time. Credentials are not committed; logs redact URL passwords and never log message bodies or provider payloads.

Graceful shutdown: `Spine.close()` ends the pool; SIGTERM/SIGINT on the host stop the idle watcher and close the server.

## CI PostgreSQL

`.github/workflows/ci.yml` runs a `postgres:16` service (`atlas`/`atlas`/`atlas_vnext`) and sets `DATABASE_URL` / `ATLAS_DATABASE_URL`. `npm test` and `npm run test:persistence` exercise the real adapter via per-test schemas.

## Production config

| Variable | Role |
|---|---|
| `ATLAS_PERSISTENCE=postgres` | Required in production (also implied by `NODE_ENV=production`) |
| `ATLAS_DATABASE_URL` or `DATABASE_URL` | Required; missing → fail closed |
| `ATLAS_TENANT_ID` | Required for the host composition root |
| Pool/timeout vars | Optional; defaults in `readPersistenceConfig` |

Do not point production at the JSON file or the memory kernel.
