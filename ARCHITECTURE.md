# Atlas vNext architecture

This repository is a greenfield rebuild. Atlas Mountain, Caspa, ocrowley-commons and related trees are **behavioural references**. Folder names and historical coupling from those trees are not binding.

## Stack choice

**TypeScript on Node 22**, npm workspaces, Zod schemas, Vitest.

Reasons (census, not habit):

- The strongest routing, failover, permission and job-contract tests are TypeScript (`atlas-mountain/services/nexus`, `packages/shared`).
- `@ocrowley/osint` WHO jobs + SSE are TypeScript.
- Python remains a *runtime* for compute workers and OSINT bridges, not the control plane.

HTTP (when added) will be Fastify, matching the proven Nexus server — but this phase ships **libraries + tests**, not a full HTTP product.

## Layering

```text
apps/*                user surfaces (shell). No provider or dungeon business logic.
        │
        ▼
dungeons/*            domain logic (writing, osint, …). Call platform APIs only.
        │
        ▼
platform/*
  auth, permissions, projects, storage, jobs, events,
  provenance, search, observability
  nexus          WHERE a model request should go
  execution      HOW it runs (stream, retry, adapters)
        │
        ▼
runtimes/*            local | hetzner | runpod  — process hosts, not product domains
        │
        ▼
packages/contracts    versioned schemas (the only shared language)
```

Direction of dependencies: apps → dungeons → platform → packages. `platform/nexus` depends on `packages/contracts` only. It must not import dungeons, jobs, storage, or execution.

## Core principles (normative)

### 1. Durable projects

A **project** is the source of truth for work. Conversations are objects that may attach to a project; they never own files, jobs, or artefacts. Deleting a conversation must not delete project state.

### 2. Durable jobs

Every long-running operation is a `Job` (see `docs/JOBS-AND-EVENTS.md`). Minimum fields: `id`, `projectId`, `type`, `status`, `progress`, `checkpoint`, `retry`, `cancellation`, `failure`, `traceId`, timestamps. Closing a UI does not cancel the job.

### 3. Event-driven progress

Live progress is an append-only event stream (SSE or WebSocket). Polling is a degraded client fallback, not the architecture. WHO jobs in `@ocrowley/osint` already prove SSE job progress.

### 4. Content-addressed storage

Blobs are immutable and keyed by digest. Revisions are manifests that point at blobs. Two identical files share one blob. See `docs/STORAGE-MODEL.md`.

### 5. Explicit provenance

Generated artefacts record project, input object IDs + revisions, model/provider, tool calls, job ID, timestamps, and subsequent edits. Investigation snapshot manifests are the behavioural oracle.

### 6. Capability-based permissions

Evaluation lives only in `platform/permissions`. Tools and dungeons declare scopes; they do not branch on “is this allowed?”. Scopes:

`filesystem.read`, `filesystem.write`, `network.public`, `network.private`, `browser.control`, `shell.execute`, `repo.read`, `repo.write`, `deployment.promote`, `secrets.use`, `device.control`.

Decisions: `allow` | `ask` | `deny`. Unknown scope → `ask`.

### 7. Dungeon isolation

Nexus **never** contains Writing, OSINT, Website Studio, Investigation or Research business logic. If a function needs to know what a chapter or a dossier is, it does not belong in Nexus.

### 8. Shared workspace shell

One Atlas shell. Dungeons register routes, panels, commands, inspectors, project views and object types. They do not ship a second app chrome.

### 9. Universal objects

Stable IDs, globally searchable: projects, files, artefacts, jobs, conversations, sites, chapters, characters, research items, evidence items, deployments, models. See `ObjectId` in `packages/contracts`.

### 10. Versioned schemas

Every persistent document and SQL schema has `schemaVersion` and a migration. Breaking changes require a migration module under `platform/*/migrations` or `packages/contracts/migrations`.

### 11. Feature flags

Experimental paths (`nexus/experimental`-class product bets, unfinished dungeons) are flagged off. Stable routing aliases must not depend on flagged providers.

### 12. Built-in observability

Every request and job has a `traceId`. A complete trace includes: route decision, provider attempts, retry/fallback reason, latency, cost if known, tool calls, failure classification, job progress.

### 13. Built-in evaluation

Automated suites live under `packages/testing/evals/`. Suites named in this phase (placeholders until domain code exists): route selection, provider failover, retrieval, citations, writing, code tasks, Website Studio generation, OSINT orchestration, contradiction detection, tool selection.

### 14. Transactional deployment

A release is an immutable artifact. Promote is a transaction: write new pointer → verify health → keep or roll back. A green CI build is not production health.

### 15. Backup and recovery

Restore is documented before data exists. See `ops/backup/RESTORE.md`.

## Nexus vs execution (critical)

```text
Application
    │  RouteRequest (alias or explicit target + requirements)
    ▼
Nexus Router          configuration-driven
    │  RouteDecision { candidates[], trace }
    ▼
Execution Broker      streaming, retries, timeouts, circuit breakers
    │
    ▼
Provider Adapters     OpenAI | Anthropic | Gemini | Venice | Ollama | RunPod | Forge
```

**Nexus owns:** provider registry, model discovery *results*, capability registry, routing policy, provider health *as routing input*, cost/latency metadata, capability aliases, request normalisation, route traces.

**Nexus does not own:** retries, streaming mechanics, provider HTTP, domain workflows, projects, storage, dungeon logic.

**Execution owns:** adapter I/O, streaming, retries/timeouts, protocol quirks, circuit breakers, worker lifecycle, transport error classification.

Failure mode: if you are about to add `setTimeout` or `fetch` inside `platform/nexus`, you are in the wrong package.

## Data flow (chat completion)

1. App creates/attaches a `Job` only if the work can outlive the request. Short completions may skip a job but still emit a trace.
2. App builds `RouteRequest` with alias (`nexus/reason`) and requirements (`tools: true`, `minContextWindow`, `localOnly`).
3. Nexus returns ordered `candidates` excluding unhealthy providers (unless explicit target — explicit does not fail over at route time).
4. Execution walks candidates. Retryable pre-output errors retry the same adapter once. Then next candidate. **Any visible text commits the provider; later failure is a failed job, not a second answer.**
5. Events (`route.resolved`, `provider.attempt`, `token.delta`, `job.progress`, `job.failed`) go to `platform/events`.
6. Artefacts written to CAS with a provenance record.

## Failure modes (platform)

| Failure | Owner | Behaviour |
|---|---|---|
| Unknown alias | Nexus | `route.unknown_alias` — do not guess |
| No healthy candidate | Nexus | `route.no_candidate` |
| Explicit target unhealthy | Nexus | fail closed (no silent fallback) |
| Local-only + only cloud models | Nexus | `route.locality_violation` |
| Context window too small | Nexus | skip model; if none remain, fail |
| Tools required, model has `tools: false` | Nexus | skip |
| Timeout / 429 / 5xx before text | Execution | one retry, then next candidate |
| Auth / 4xx / context_length | Execution | no retry; next candidate (capability routes only) |
| Text already streamed, then die | Execution | surface failure; **never** start another model |
| Adapter throws non-classified error | Execution | treat as `unknown`; no retry |
| Circuit open | Execution | skip adapter; record in trace |
| Job worker crash | Jobs | lease expires; another worker resumes from checkpoint |
| Blob digest mismatch | Storage | reject write; do not “repair” by overwriting |

## Monorepo layout

Boundaries matter more than cosmetics. Current tree:

```text
apps/web|desktop|mobile     shells (stubs)
platform/nexus              routing core (implemented)
platform/execution          broker + fake adapters (implemented)
platform/{auth,projects,storage,jobs,events,permissions,provenance,search,observability}
dungeons/{writing,investigation,research,website,music,osint}  stubs
runtimes/{local,hetzner,runpod}  stubs
packages/contracts          versioned schemas (implemented)
packages/{sdk,ui,config,testing,shared}
ops/{deploy,backup,monitoring}
```

## What this phase implements vs stubs

Implemented: contracts, Nexus router, execution broker, fake adapters, Nexus contract tests, eval placeholders, backup/deploy runbooks, census + architecture docs.

Stubbed: HTTP servers, real provider clients, dungeons, UI shell, auth/storage/jobs services, runtimes.

## Divergence from Atlas Mountain (intentional)

| Atlas Mountain | vNext |
|---|---|
| Nexus = entire backend | Nexus = routing library |
| Failover adapter inside `resolveRoute` | Execution broker |
| Aliases hardcoded to `anthropic/claude` | Aliases match capabilities + cost/latency/locality |
| Projects optional on conversations | Projects authoritative |
| Artifacts unique by path | Blobs by digest + manifests |
| Four job stores | One job type |
| Dungeon logic in `services/nexus/src/{writing,research,...}` | `dungeons/*` |
| Coarse permission scopes + dotted extras | Closed list of platform scopes |
| SQLite as the product | SQLite allowed as a *store implementation*, not the model |
