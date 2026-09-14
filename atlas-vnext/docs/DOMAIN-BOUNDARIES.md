# Domain boundaries

**Nexus decides WHERE work goes. Execution decides HOW it runs. Dungeons own WHAT is being done. Platform primitives own durability.**

Direct imports across dungeons, and Nexus importing domain or transport, are forbidden. Enforced by `tests/architecture` (TypeScript import graph + `package.json`), including a committed negative fixture.

## Nexus (`platform/nexus`)

Owns: registry, aliases (`nexus/fast|reason|code|vision|cheap|local|frontier`), ranking, recorded health, route traces, privacy/cost/latency/locality policy.

Does not own: fetch, streaming parsers, retries, circuit breakers, jobs, SQL, dungeons, Caspa, OSINT.

## Execution (`platform/execution`)

Owns: adapters, HTTP, stream normalisation, timeouts, failover before visible text, tool-call buffering, circuit breakers, worker leases, the secrets port.

Does not own: route policy, UI, project/CAS writes, dungeon modules.

## Platform primitives

| Package | Owns |
|---|---|
| `projects` | Authoritative project records + current manifest pointer |
| `storage` | CAS blobs + manifests; never in-DB binaries; retention bounds stub |
| `jobs` | Shared state machine, checkpoints, leases |
| `events` | SSE fan-out |
| `provenance` | Artefact lineage |
| `permissions` | Capability scopes; default deny; Behaviour ≠ Authority stubs |
| `observability` | Route/attempt traces including rejects |
| `flags` | Feature flags |
| `conversation` | Conversation, message, and execution state |
| `persistence` | Local/dev durable metadata adapter |

None of these are dungeon modules. None may import dungeons.

## Dungeons

| Dungeon | Owns | Must not |
|---|---|---|
| writing | one Book Project (manuscript, claims, stylometry) | import OSINT/investigation; own a job runner or writing DB |
| investigation | caseboard, evidential agents | import writing; talk to OpenAI SDK; embed OSINT adapters |
| research | federated search, synthesis | poll in-process; embed SpiderFoot in Nexus; duplicate retrieval |
| website | site gen, audits, preview vs production | mount preview servers on Nexus; copy trees per revision |
| osint | targets, adapters, findings | vendor TheBigBrother into Nexus |
| music | composition, stems | put GPU leasing in Nexus |

Dungeons may call Nexus (route) and the Execution **broker** (run). They may not import `platform/execution/src/adapters/*` or provider SDKs.

## Conversation domain (`platform/conversation`)

Owns conversation, message, and execution records. Does not import Nexus or execution adapters. The host injects a capability router and a model executor.

## Flow

```text
UI  →  host (composition root)
    →  conversation runtime
         →  Nexus.resolve(alias) → RouteDecision
         →  ExecutionBroker.execute(decision)
         →  durable conversations / messages / executions / events
```
