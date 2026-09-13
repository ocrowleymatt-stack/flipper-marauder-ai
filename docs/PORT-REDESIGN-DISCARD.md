# Port / redesign / discard decisions

“Port” means re-implement the behaviour and its tests behind a vNext contract.
It never means copy a legacy module or preserve its architecture.

| Capability or artefact | Source | Decision | vNext owner / reason |
|---|---|---|---|
| Deterministic capability resolution and local-only filtering | Atlas Mountain | **Port behaviour** | Nexus; pure resolution over registry snapshots |
| Auto-routing keyword layers | Atlas Mountain | **Redesign + merge** | Nexus policy plus measured eval fixtures |
| Retry/failover, transactional tool buffering, no switch after visible output | Atlas Mountain | **Port behaviour** | Broker; load-bearing correctness contract |
| Health, cooldown, performance, cost | Atlas Mountain | **Redesign + merge** | One broker-owned provider registry |
| Provider adapters and model IDs | Atlas Mountain | **Redesign** | Provider SPI; runtime configuration, no IDs in router code |
| Three domain job stores and polling loops | Atlas Mountain | **Discard implementations** | Replace with one leased job/event substrate |
| Investigation run recovery and assurance semantics | Atlas Mountain | **Port behaviour** | Jobs/events plus Investigation plugin provenance |
| Claim ledger, factuality gate, evidence library, publication lock | Atlas Mountain / Caspa | **Port behaviour** | Writing plugin over common provenance/content |
| Checkpointed commission, QA hold, retained partial result | Caspa | **Port behaviour** | Writing jobs; no app-owned worker pool |
| Caspa recovery client retries | Caspa | **Redesign** | Typed incident events; broker owns retries |
| Job checksum/excerpt provenance | Caspa | **Redesign + extend** | Uniform provenance includes derivation/source chain |
| Lease, heartbeat, cancellation, partial/resume job cases | ocrowley-commons | **Port behaviour** | Broker durable jobs; relational, not file-per-job |
| Temp-file atomic local writes | ocrowley-commons | **Port behaviour** | Local storage adapter only |
| File-per-record persistence | ocrowley-commons | **Discard as core store** | Relational core and content-addressed blob store |
| Default-deny prioritized policy decisions | ocrowley-commons | **Port behaviour** | Broker capability evaluator with decision evidence |
| Hash-chained audit ledger | ocrowley-commons | **Port behaviour** | Durable event/audit projection |
| AES-GCM and integrity verification | ocrowley-commons | **Port behaviour** | Vault boundary, with rotation and escrow added |
| Case/operator-gated OSINT and honest unavailable results | ocrowley-commons | **Port behaviour** | OSINT plugins; capability and provenance required |
| OSINT module catalogue and target-specific fan-out | TheBigBrother | **Redesign** | Authorized broker fan-out jobs with evidence envelopes |
| Heuristic risk score and “weaponized” scanner engines | TheBigBrother | **Discard** | Insufficient provenance; dual-use risk; never vendor |
| Risk-tiered approval chain and no-go state | Life-os | **Port behaviour** | Durable permission suspension and CI gates |
| Mock builder/tester/reviewer factory | Life-os | **Discard** | Not product functionality or a production execution model |
| Local-first writing projects | Shakespeare- | **Port user cases** | Durable Projects with offline-capable shell projection |
| EPUB export behaviour | Shakespeare- | **Port later** | Capability-gated Writing tool after substrates |
| Duplicate Shakespeare app shell/components | Shakespeare- | **Discard** | One shell and one Writing plugin |
| Sensitivity-based sharing defaults | craigs-navigator | **Port behaviour** | Capability constraints and explicit consent receipts |
| Evidence-first/non-diagnostic companion posture | craigs-navigator | **Port policy** | Future companion plugin plus provenance |
| Capacitor bridge shape | handsy-ios | **Redesign if needed** | Device relay capability advertisement |
| Stub call recorder and empty handy-ios | handsy-ios / handy-ios | **Discard** | No proven behaviour |
| Attachment/artifact/ingest byte stores | Atlas Mountain | **Redesign + merge** | One content-addressed store, metadata views |
| Project/conversation durability and ordered migrations | Atlas Mountain | **Port discipline** | Storage relational core |
| Vault encrypted-at-rest pattern | Atlas Mountain | **Port + extend** | Add escrow and tested restore |
| SSE progress and disconnected telemetry paths | Atlas Mountain / commons | **Redesign + merge** | Durable replayable events and one correlation ID |
| Loopback core plus authenticated edge | Atlas Mountain | **Port topology** | Edge gateway |
| Per-domain GPU clients and static caps | Atlas Mountain | **Discard implementations** | Broker workload classes and lease backpressure |
| Dungeon contract and versioned skill manifests | Atlas Mountain | **Port concepts** | `plugin-sdk`; signed/capability-scoped registry later |
| CSS skin accretion, `*Ultimate` forks, repair/install script sprawl | Atlas Mountain / Caspa | **Discard** | Non-behavioural duplication |
| Canary/verify/rollback deployment tests | Atlas Mountain / Caspa | **Port practice** | One transactional deployer after design gate |

## Gate decision

The first design gate approves contracts and boundaries only. It does **not**
approve provider integrations, durable-store implementation, domain engines,
UI product work, deployment, or legacy code migration. Those require later
case-first changes in the order defined by `MIGRATION-PLAN.md`.
