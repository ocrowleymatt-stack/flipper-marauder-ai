# Atlas vNext Architecture

Greenfield rebuild. Atlas Mountain is a **behavioural** reference, not a folder template.

This document describes the target system. The design-gate tree lives entirely under `atlas-vnext/` inside `flipper-marauder-ai`. It does not inherit Atlas Mountain’s `services/nexus`, turbo `apps/desktop` + `services/*` workspace, or nginx `/v12` compatibility surface. It also does **not** inherit the unrelated Java/Spring Boot `lystrosaurus/atlas-mountain` stub.

Canonical design-gate branch: `cursor/atlas-vnext-design-gate-2e35`. Duplicate `atlas-vnext-*` branches are scrap.

See also: [BORING-CORE.md](./docs/BORING-CORE.md), [CAPABILITY-CENSUS.md](./docs/CAPABILITY-CENSUS.md).

## 1. Principles

1. Durable projects are authoritative; chat is ephemeral.
2. Durable jobs own long-running work (status, checkpoint, lease, retry, cancel, trace, structured failure).
3. Progress is event-driven (SSE first), not polling loops.
4. Files live in content-addressed storage (CAS). PostgreSQL stores hashes and metadata only.
5. Artefacts carry explicit provenance.
6. Permissions are capability scopes evaluated by a platform gate (default deny).
7. Dungeons own domain logic. Nexus never does.
8. One shared app shell; dungeons plug in.
9. Universal object IDs (`urn:atlas:<type>:<id>`).
10. Versioned schemas.
11. Feature flags for experiments.
12. Built-in observability (route, attempts, cost, tools).
13. Built-in evaluation.
14. Transactional deployment with rollback.
15. Backup and recovery from day one.

## 2. Topology

```text
apps (future)  →  dungeons  →  platform primitives
                      │
                      ├─ Nexus (WHERE: registry, aliases, policy, health snapshots)
                      └─ Execution (HOW: transport, retry, circuit breaker, streaming)
```

Unidirectional rules:

- Nexus must not import dungeons, execution adapters, HTTP clients, jobs, or storage.
- Execution must not import Nexus or dungeons; it consumes `RouteDecision` from contracts.
- Dungeons must not import other dungeons or provider adapters.
- Jobs, events, storage, provenance, permissions, observability, flags, and projects are platform packages, not dungeon packages.
- Apps depend on contracts/interfaces, not provider SDKs.

## 3. Nexus vs Execution

| | Nexus | Execution |
|---|---|---|
| Question | WHERE should this run? | HOW does it run? |
| Owns | Registry, aliases, ranking, recorded health, cost/latency/locality/privacy policy, immutable `RouteDecision` | Adapters, fetch/SSE/NDJSON, retries, circuit breakers, tool-call buffer, failure classification |
| Output | `RouteDecision` | `StreamChunk` sequence |

Health probes may *write* snapshots into the registry. Opening sockets to providers is execution/runtime work.

Invariant: if a provider fails **before** visible assistant output, failover may continue. If visible assistant text has already been emitted, do **not** silently switch providers.

## 4. Layout (this repository)

```text
flipper-marauder-ai/
├── README.md
└── atlas-vnext/
    ├── packages/contracts
    ├── platform/{nexus,execution,projects,jobs,events,storage,provenance,permissions,observability,flags}
    ├── dungeons/{writing,investigation,research,website,osint,music}
    └── tests/architecture
```

## 5. Persistence (target)

- **PostgreSQL** for transactional metadata: projects, jobs, grants, manifest pointers, provenance, outbox. Justified in [BORING-CORE.md](./docs/BORING-CORE.md). SQLite is a local/dev stand-in with the same schema, not a second product database.
- CAS blobs: `objects/sha256/ab/cd/<hex>`. Never file bytes or base64 in relational rows.
- Manifests: deterministic JSON hashed as their own objects.
