# Atlas vNext

Greenfield rebuild of Atlas.

> Atlas Mountain is a behavioural reference, not an architectural template.

This repository is the product. Existing Atlas-related repositories are sources of proven behaviour, tests and operational lessons; they are not copied wholesale.

## Read first

| Document | What it defines |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layers, Nexus vs execution, failure modes, stack choice |
| [docs/CAPABILITY-CENSUS.md](docs/CAPABILITY-CENSUS.md) | Where behaviour lives today, what to port/redesign/discard |
| [docs/DOMAIN-BOUNDARIES.md](docs/DOMAIN-BOUNDARIES.md) | Who may know what |
| [docs/NEXUS-CONTRACT.md](docs/NEXUS-CONTRACT.md) | Registry, aliases, route traces, contract tests |
| [docs/STORAGE-MODEL.md](docs/STORAGE-MODEL.md) | Content-addressed blobs + manifests |
| [docs/JOBS-AND-EVENTS.md](docs/JOBS-AND-EVENTS.md) | Durable jobs, SSE progress |
| [docs/MIGRATION-PLAN.md](docs/MIGRATION-PLAN.md) | How behaviour and data move without copying trees |
| [ops/backup/RESTORE.md](ops/backup/RESTORE.md) | Restore before we have production data |
| [ops/deploy/TRANSACTIONAL-DEPLOY.md](ops/deploy/TRANSACTIONAL-DEPLOY.md) | Immutable releases, verify, rollback |

## Layout

```text
apps/           web / desktop / mobile shells
platform/       nexus (routing) · execution (how it runs) · jobs, storage, …
dungeons/       domain plugins — stubs until the platform is stable
runtimes/       local · hetzner · runpod
packages/       contracts · sdk · testing · …
ops/            deploy · backup · monitoring
```

Nexus decides **where** a model request should go. Execution decides **how** it runs. Dungeons own Writing, OSINT, Website Studio, Investigation and Research. Nexus contains none of that.

## Stack

TypeScript, Node 22, npm workspaces, Zod, Vitest. Chosen because the strongest routing, failover and job-contract implementations in the census are already on this stack (`ARCHITECTURE.md`).

## Develop

```bash
npm install
npm test
```

This phase ships contracts, a configuration-driven Nexus router, an execution broker with fake adapters, and the Nexus contract tests. It does **not** ship dungeon business logic or production provider clients.

## Capability aliases

Applications request `nexus/fast`, `nexus/reason`, `nexus/code`, `nexus/vision`, `nexus/cheap`, `nexus/local`, `nexus/frontier`, or an explicit `{ providerId, modelId }` for tests.
