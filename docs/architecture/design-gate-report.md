# Design-gate report

**Gate:** 1 — architecture, census, contracts, skeleton, CI, boundary tests.
**Stopped here:** no major product implementation, no bulk port.

## What was found

This environment’s linked repo is only `flipper-marauder-ai`. Atlas
Mountain is not cloneable with the current GitHub token. The original
rebuild prompt appears as (a) this task, (b) the vNext README init, and
(c) a prior census branch that had a local Mountain checkout.

The important surprise is how much Atlas behaviour **already lives
outside Mountain**: Caspa as a full literary OS and recovery-fabric
client; ocrowley-commons as extracted jobs/SSE/policy/audit/OSINT;
Life-os HITL factory; Flipper/Marauder as this repo’s original product;
OSINT `who()` with durable jobs and hash-chained audit.

Mountain, inferred from Caspa’s systemd unit and the prior census, is a
successful but overloaded Nexus: good failover and permission
suspension, bad god-object and triplicate jobs/storage/telemetry.

## What is proposed

A clean-room monorepo in this repository:

- small Nexus router (CI size + import budget)
- separate execution broker (only side-effect path)
- one durable job/project substrate
- CAS with mandatory provenance
- event log with SSE replay
- capability tokens at one choke point
- dungeons as isolated plugins, including **device-marauder**
- Caspa remains an external consumer

See [overview.md](./overview.md) and [port-redesign-discard.md](./port-redesign-discard.md).

## What later gates will do (not now)

| Gate | Work |
|---|---|
| 2 | Storage stub → durable CAS + migrations + backup drill |
| 3 | Nexus resolver + registry boot validation + eval fixtures |
| 4 | Broker failover + streaming + permission suspension |
| 5 | Edge gateway (native + Authentik issuance) |
| 6 | Investigation plugin on jobs/events |
| 7 | Writing commissions + Caspa consumer contract |
| 8 | OSINT/research plugins (`who()` behaviour) |
| 9 | Device/Marauder relay + serial/BLE capability |
| 10 | Website Studio / music / quantum plugins |
| 11 | Transactional deploy + owned inference adapters |

## Risks

| Risk | Mitigation |
|---|---|
| Pressure to copy Mountain files | Import bans + this gate’s tests |
| Plugin contract too thin for Investigation | Investigation is the first real plugin later; contract may rev |
| Mountain source unavailable here | Behaviour captured in census; next environment should add Mountain as a **read-only** extra checkout without merging it |
| Capability model vs existing Authentik groups | Edge issues tokens; broker never sees groups |
| Flipper product forgotten because README was overwritten | `dungeons/device-marauder` reserved now |

## Acceptance for Gate 1

- [x] Census of accessible repos + explicit out-of-Mountain findings
- [x] Architecture overview + ADRs
- [x] Port/redesign/discard table
- [x] JSON Schema + TS contracts
- [x] Monorepo skeleton (stubs only)
- [x] Architecture-boundary tests in CI
- [x] No product ports
