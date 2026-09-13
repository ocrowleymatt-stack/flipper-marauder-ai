# Port / Redesign / Discard

Decisions for Atlas vNext. “Port” means **re-implement behaviour and
test cases** behind the new boundary — never copy files from Atlas
Mountain or sibling apps.

## Platform core

| Capability | Decision | Rationale |
|---|---|---|
| Thin capability routing table | **Redesign** | Keep ids/chains/`localOnly`; move out of fat Nexus; table is data |
| Auto/intent classification | **Merge + Redesign** | Collapse Mountain’s three auto layers + Caspa `classifyTask` into one eval-gated step owned by Nexus |
| Provider failover / streaming | **Port** | Tool-call buffering + no-failover-after-visible-text is the correctness core |
| Billing/quota as routing signal | **Port** (from Caspa) | Stronger than Mountain; do not terminate jobs on one vendor’s bill |
| Provider health four-state model | **Port** | `healthy / configured / auth_failure / unavailable` |
| Health + cooldown + perf ledger | **Merge** | One registry `canServe()` |
| Vendor adapters | **Port** pattern, **Merge** xAI | One `ProviderAdapter` SPI in the broker |
| Ollama local-only | **Port** | Privacy by construction |
| Unified Router / Forge / Hetzner / RunPod | **Redesign** | Ordinary adapters; owned-first is registry priority; fail boot if primary missing |
| Compute fabric | **Redesign + Merge** | Shared pool, workload classes; delete per-dungeon GPU clients |
| Durable jobs | **Merge + Redesign** | One state machine; Caspa idempotency + Mountain run-recovery |
| Event log / SSE | **Redesign** | Commons SSE + Caspa jobs; no polling loops |
| CAS + provenance envelope | **Redesign** | Replace attachments/artifacts/ingest/Caspa files with one store |
| Hash-chained audit | **Port** (commons/Mn) | Spec, not a runtime dependency on commons |
| Capability permissions | **Redesign** | Single broker choke; port human-suspension |
| Role/Authentik groups | **Redesign** | Issue tokens at the edge only |
| Native auth + mobile gateway | **Port** topology | Loopback core + authenticated edge |
| Fail-closed identity headers | **Port** (Caspa) | Strip client-supplied identity |
| Vault secrets | **Port** semantics | Add **key escrow + restore drill** (Mountain gap) |
| Recovery fabric | **Split** | Execution retry stays broker; data backup is a separate domain |
| Observability | **Redesign** | One correlation id; redaction-by-default |
| Evaluation harness | **New** (required) | Gate routing heuristics before they ship |
| Transactional deploy | **Redesign** | Canary + verify + rollback; specialist installs non-fatal |
| Plugin / Dungeon contract | **Redesign** | Enforce with import tests; Mountain contract was too weak |
| Skills format | **Port** | Versioned markdown + manifest, registry-distributed |
| Doctor/ops | **Port** | Public coarse vs authenticated detailed |
| Intent: plan ≠ write | **Port** (commons) | Literary and tool-plan safety |
| HITL factory (Daedalus/Themis) | **Redesign** | Change-control jobs + capability gates; not a second Nexus |
| Honest search unavailability | **Port** | Never fabricate web results |

## Domain modules

| Domain | Decision | Rationale |
|---|---|---|
| Investigation | **Redesign** as reference plugin | Keep run-recovery/assurance; scheduler becomes broker jobs |
| Writing (Mountain dungeon) | **Redesign** | Claim ledger, factuality, publication lock → platform-adjacent; commissions → jobs |
| Caspa app | **Do not copy** | Consumer of vNext jobs/events/recovery; craft stays in Caspa |
| Research / OSINT | **Port** federation + RRF + target gating; **Redesign** evidential envelope on every path | `who()` jobs+SSE from commons are the API shape to prefer |
| Dark-web clearnet indexes | **Port** behind capabilities | No in-process Tor |
| TheBigBrother engines | **Discard vendoring** | Optional bridge only |
| Website Studio | **Redesign** | Preview is a CAS read path + retention job |
| Music | **Redesign** | One plugin; discard install-script sprawl |
| Quantum | **Port as plugin** | Already self-contained; provenance on compiled artifacts |
| Device relay / Atlas OS | **Merge** one protocol; **Port** safety-without-network | |
| Flipper / Marauder | **Redesign** as dungeon | Outside Mountain; BLE/USB serial + firmware + voice/text guidance |
| Compute / GPU | **Platform** | Not a dungeon |
| Shakespeare UI | **Discard** as product | Persistence lessons already in commons |
| craigs-navigator | **Port** privacy honesty contracts only | |
| handsy-ios / handy-ios | **Discard** | Legal/App Store risk; empty stubs |
| Firebase/Firestore Caspa paths | **Discard** | PostgreSQL + CAS + local-first are the vNext story |
| CSS skins / `*Ultimate` forks | **Discard** | |
| Repair scripts / string-match bans | **Discard** | |
| Break-glass as normal path | **Discard** | Documented procedure only |

## Tests to port (cases, not files)

Priority families (rewrite against doubles until real modules exist):

- Failover / streaming / error taxonomy
- Capability routing + local-only + boot-time unresolved primary
- Permissions suspension
- Investigation run-recovery
- Attachment/CAS provenance + processing state
- Research search federation + public-target safety
- Caspa job idempotency + checksum provenance
- Audit ledger verify
- Nginx/identity fail-closed
- Filesystem sandbox / path-safety
- Doctor sanitisation
- Deploy canary/verify (later gate)

## Explicitly out of this gate

Implementing any row above as product code. This document is the
decision record; later gates execute it case-first.
