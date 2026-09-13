# Atlas vNext Architecture

Greenfield rebuild. Atlas Mountain is a **behavioural** reference, not a folder template.

This document describes the target system. The design-gate tree lives entirely under `atlas-vnext/` inside `flipper-marauder-ai`. It does not inherit Atlas Mountain’s `services/nexus`, turbo `apps/desktop` + `services/*` workspace, or nginx `/v12` compatibility surface.

## 1. Principles

1. Durable projects are authoritative; chat is ephemeral.
2. Durable jobs own long-running work (status, checkpoint, lease, retry, cancel, trace).
3. Progress is event-driven (SSE/WebSocket), not polling loops.
4. Files live in content-addressed storage (CAS). Relational DBs store hashes and metadata only.
5. Artefacts carry explicit provenance.
6. Permissions are capability scopes evaluated by a platform gate.
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
- Jobs, events, storage, provenance, permissions, and projects are platform packages, not dungeon packages.

## 3. Nexus vs Execution

| | Nexus | Execution |
|---|---|---|
| Question | WHERE should this run? | HOW does it run? |
| Owns | Registry, aliases, ranking, recorded health | Adapters, fetch/SSE/NDJSON, retries, circuit breakers, tool-call buffer |
| Output | `RouteDecision` | `StreamChunk` sequence |

Health probes may *write* snapshots into the registry. Opening sockets to providers is execution/runtime work.

## 4. Layout (this repository)

```text
flipper-marauder-ai/
├── README.md                 # existing repo pointer (Flipper / Atlas intro)
└── atlas-vnext/              # design-gate only
    ├── packages/contracts
    ├── platform/{nexus,execution,projects,jobs,events,storage,provenance,permissions}
    ├── dungeons/{writing,investigation,research,website,osint,music}
    └── tests/architecture    # TypeScript import-graph checker
```

Future apps, runtimes, and ops live under `atlas-vnext/` as well. They are not copied from Atlas Mountain’s `apps/`, `deploy/hetzner/`, or `scripts/`.

## 5. Persistence (target)

- SQLite (or equivalent) for metadata, jobs, grants — WAL, migrations, no blobs.
- CAS blobs: `objects/sha256/ab/cd/<hex>`.
- Manifests: deterministic JSON hashed as their own objects.
