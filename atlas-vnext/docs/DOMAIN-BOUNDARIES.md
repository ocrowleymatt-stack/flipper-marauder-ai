# Domain boundaries

**Nexus decides WHERE work goes. Execution decides HOW it runs. Dungeons own WHAT is being done. Platform primitives own durability.**

Direct imports across dungeons, and Nexus importing domain or transport, are forbidden. Enforced by `tests/architecture`.

## Nexus (`platform/nexus`)

Owns: registry, aliases (`nexus/fast|reason|code|vision|cheap|local|frontier`), ranking, recorded health, route traces.

Does not own: fetch, streaming parsers, retries, circuit breakers, jobs, SQL, dungeons, Caspa, OSINT.

## Execution (`platform/execution`)

Owns: adapters, HTTP, stream normalisation, timeouts, failover before visible text, tool-call buffering, circuit breakers, worker leases.

Does not own: route policy, UI, project/CAS writes.

## Platform primitives

| Package | Owns |
|---|---|
| `projects` | Authoritative project records + current manifest pointer |
| `storage` | CAS blobs + manifests; never in-DB binaries |
| `jobs` | Shared state machine, checkpoints, leases |
| `events` | SSE/WebSocket fan-out |
| `provenance` | Artefact lineage |
| `permissions` | Capability scopes (`filesystem.read`, `shell.execute`, …) |

None of these are dungeon modules.

## Dungeons

| Dungeon | Owns | Must not |
|---|---|---|
| writing | manuscripts, claims, stylometry | import OSINT/investigation; own a job runner |
| investigation | caseboard, evidential agents | import writing; talk to OpenAI SDK |
| research | federated search, synthesis | poll in-process; embed SpiderFoot in Nexus |
| website | site gen, audits, preview | mount preview servers on Nexus |
| osint | enumeration, dossiers | vendor TheBigBrother into Nexus |
| music | composition, stems | put GPU leasing in Nexus |

Dungeons may call Nexus (route) and the Execution **broker** (run). They may not import `platform/execution/src/adapters/*` or provider SDKs.

## Flow

```text
Dungeon  →  permissions gate
         →  projects / storage / jobs / events / provenance
         →  Nexus.resolve(alias) → RouteDecision
         →  ExecutionBroker.execute(decision)
```
