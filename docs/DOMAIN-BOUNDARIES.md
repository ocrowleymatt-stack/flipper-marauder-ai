# Domain boundaries

Ownership is defined by **what a package is allowed to know**. Import edges that violate this table are bugs.

## Package map

| Package | May know | Must not know |
|---|---|---|
| `packages/contracts` | IDs, enums, Zod schemas, schemaVersion | I/O, dungeons, Node APIs |
| `packages/config` | Registry JSON, feature flags, env mapping | Routing algorithms, HTTP |
| `packages/sdk` | How apps call platform APIs | Provider protocols |
| `packages/ui` | Shell primitives, tokens | Nexus, jobs internals |
| `packages/testing` | Fakes, eval harness | Production I/O |
| `platform/nexus` | Registry, aliases, route requests | `fetch`, retries, dungeons, projects, storage |
| `platform/execution` | Adapters, streams, retries, circuit breakers | Chapter/dossier/site types |
| `platform/jobs` | Job state machine, leases | Why a writing commission exists |
| `platform/events` | Envelope, stream fan-out | Event *payload* meaning |
| `platform/storage` | Blobs, manifests, refs | Model routing |
| `platform/projects` | Project aggregate, membership | Provider ids as business rules |
| `platform/permissions` | Scope evaluation | Tool implementation |
| `platform/auth` | Identity, sessions, tenants | Model selection |
| `platform/provenance` | Lineage records | Generating text |
| `platform/search` | Indexing universal objects | Dungeon ranking heuristics |
| `platform/observability` | traces, metrics, cost | Changing routes |
| `dungeons/*` | Their objects + platform APIs | Other dungeons' internals; Nexus internals |
| `apps/*` | Shell composition, dungeon slots | Provider HTTP |
| `runtimes/*` | How/where processes run | Product domain types |
| `ops/*` | Deploy, backup, monitor | Application imports |

## Nexus is small

Legal Nexus inputs: `RouteRequest`, current `ProviderRegistry` (models + health + cost/latency/capabilities).

Legal Nexus outputs: `RouteDecision` (ordered candidates) and `RouteTrace`.

If Nexus needs a project id to choose a model, the *application* should have already turned project policy into `RouteRequest.policy` (e.g. `localOnly: true`).

## Dungeons

A dungeon is a plugin:

```text
DungeonManifest
  id            "dungeon.writing"
  objectTypes   ["chapter", "character", …]
  jobTypes      ["writing.commission"]
  routes        ["/writing/:projectId"]
  panels        ["manuscript", "claims"]
  commands      ["writing.commission.start"]
  requiredScopes
```

Dungeons **may** request capability aliases (`nexus/reason`) and **must not** import `platform/nexus` internals. They call `sdk.route()` / `sdk.jobs.start()`.

Cross-dungeon collaboration goes through **universal objects and events**, not through importing another dungeon package.

## Apps

`apps/web` is the shared shell. `apps/desktop` and `apps/mobile` wrap the same shell (later). No dungeon reimplements navigation, model health, permission prompts, or job toasts.

Product zones (behavioural reference: `atlas-mountain/docs/product-shell.md`):

1. Context navigation (project, library, conversations)
2. Work surface (dungeon + conversation)
3. Control plane (route, health, permissions, jobs, traces)

## Runtimes vs providers

- `runtimes/local` — this machine: Ollama, filesystem, companion, Playwright.
- `runtimes/hetzner` — always-on host: control plane, SQLite/CAS disk, nginx.
- `runtimes/runpod` — ephemeral GPU.

A runtime **registers** models and worker endpoints into the registry. It is not a route alias. `runpod/writing` as a product lane is retired; writing jobs ask for a GPU-capable cheap/code route, and the registry may include a RunPod model.

## Forbidden couplings (lint targets)

1. `platform/nexus/**` importing `dungeons/**` or `platform/execution/**`.
2. `dungeons/writing/**` importing `dungeons/osint/**` (use objects/events).
3. `apps/**` importing provider adapter files.
4. Permission checks outside `platform/permissions`.
5. New SQL columns without a migration and schemaVersion bump.

## Feature flags

Flags live in `packages/config`. Experimental dungeons default off. Routing aliases used in production tests (`nexus/fast` … `nexus/frontier`) must resolve using only unflagged models.
