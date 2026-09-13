# Atlas vNext — Migration Plan

How we get from the census to the architecture without a flag-day rewrite and
without bulk-copying legacy code. Governing constraint (from the vNext
`README`): **no bulk copy before the design gate is complete** — this document
*is* the design gate output, so migration proceeds in small, contract-first
increments after it.

---

## 0. Design gate (this change — complete when merged)

- [x] Repository census (`docs/CAPABILITY-CENSUS.md`)
- [x] Architecture + boundaries + storage + jobs/events + Nexus contract (this set)
- [x] Nexus contract test scaffold (`tests/nexus-contract/`, dependency-free)
- Rule from here on: every port moves **cases first, code second** — the
  legacy test expectation lands in the owning vNext package before any
  implementation, and passes against doubles where the module does not exist yet.

## 1. Phase A — Substrates (no behaviour yet)

**A1. `packages/contracts`.** Canonical types: capability/route/resolution,
job/event envelopes, provenance envelope, tool IO, error codes, session
capabilities. Port the *shapes* from `@atlas/shared` (§1) with cleaned names;
no logic. Acceptance: compiles; contract tests import types only.

**A2. `packages/storage` skeleton.** Content-addressed blob API + relational
core with the first migrations (tenants, projects, conversations, jobs,
events, tool_executions, vault_meta, snapshots) + Vault-pattern secrets with
 escrow design + backup/restore drill harness. Port migration *discipline*
(§24), not rows. Acceptance: backup→destroy→restore drill passes on fixtures.

**A3. Provider SPI + registry.** `packages/provider-spi` (adapter interface,
error taxonomy, fake-adapter test harness) + broker registry module (health /
cooldown / durable perf ledger / cost data / boot validation). Ported cases:
`provider-health`, `failover-provider`, `providers*`, `hetzner-auto-routing`
(rewritten as "unresolvable primary refuses boot"). Acceptance: Nexus contract
cases 5, 6, 12 pass against fakes.

**A4. `packages/eval` harness.** Baseline runner + fixtures for intent
classification. Nothing to port (new scope); it gates all later routing work.

## 2. Phase B — Nexus + broker core (first runnable slice)

**B1. Nexus router.** Ingress normalization, capability table as data, policy
assembly (persona/posture/retrieval inputs), budget checks, intent handoff.
Acceptance: contract cases 1–4, 10, 11 resolve correctly against fake registry.

**B2. Broker execution.** Provider invocation with the failover contract,
permission choke point with durable suspension, tool execution for a minimal
toolset (echo/math/time fakes, then web-fetch), correlated tracing.
Ported cases: `failover-provider`, `streaming`, `permissions`,
`agent-loop` (loop semantics only — the legacy 447-line loop is *not* ported;
a small broker-native turn runner replaces it). Acceptance: contract cases
7–9 pass.

**B3. Edge gateway.** Session/pairing/loopback proxy ported from
`mobile-gateway.ts` topology (§15) with the unified session model. Acceptance:
`mobile-access`, `breakglass` (as documented procedure, not legacy code),
`sso-tenancy` cases.

**B4. Shell skeleton.** Conversations/projects/permissions/activity over the
new APIs; project-scoped retrieval gating ported (§23). Dungeon UI contract
v1 declared (panel registration only).

## 3. Phase C — Jobs, events, content (platform complete)

**C1. Durable jobs + events.** Job state machine, leases/heartbeats, durable
suspension, idempotency, cancellation, dead-lettering, SSE replay.
Ported cases: `research-fabric`, `investigation-runs`, `investigation-run-recovery`
(recovery semantics graduate here), `writing-headless-worker` (observability
habits). Legacy poll loops are deleted, not ported. Acceptance: a
commission-shaped job survives broker restart mid-run in a drill.

**C2. Content pipelines.** Provenance envelope everywhere, extractor plugin
pipeline (OCR/binary/media), quotas/GC as broker jobs, site-preview serving
over the artifact store with retention policy (closes the storage-pressure
class of incident). Ported cases: attachment/artifact families,
`website-studio`, `dev-preview`, `site-lifecycle`.

**C3. OSINT engines as plugins.** Federation + RRF + target gating + uniform
evidential envelope. Ported cases: `research-search`, `web-search*`,
`osint-owned-routing`, `research-public-target`.

**C4. Compute pool.** One pool, workload classes, owned-first as registry
priority. Ported cases: `compute-fabric`, `compute-governor`,
`runpod-workload-memory`. Per-dungeon GPU clients deleted.

## 4. Phase D — Dungeons as plugins (reference order)

1. **Investigation** (reference plugin): runs/sweeps/snapshots/assurance over
   jobs/events/storage; scheduler becomes broker schedule entries. Proves the
   plugin contract suffices. Ported cases: full `investigation*` family.
2. **Writing** (provenance constructs): claim ledger, factuality gate, evidence
   library, publication lock as platform-adjacent domain logic; commissions as
   jobs. Caspa integration defined as versioned consumer contracts. Ported
   cases: `writing*`, `claim-ledger`, `publication-lock`.
3. **Quantum** (near-mechanical plugin port — most self-contained): simulator,
   compiler, run provenance. Ported cases: `quantum*`.
4. **Website Studio**: lifecycle + preview over artifact store; UI panels via
   contract. Ported cases: studio/preview/portal families.
5. **Music**: engine/native/production behind one plugin; install-script
   sprawl replaced by the transactional deployer. Ported cases: `music*`.

Each dungeon ships only when its ported cases pass *and* it imports nothing
outside `plugin-sdk` + `contracts` (import-lint gate).

## 5. Phase E — Device, deploy, hardening

- **Device relay:** one protocol; companion scripts become thin clients;
  Atlas OS boundaries ported; safety-without-network invariant tested.
- **Transactional deployer:** canary + verify + rollback; deploy pytest
  practice ported; repair scripts and string-match policies deleted.
- **Recovery drills + eval baselines** green in CI; routing heuristics measured
  before they ship; secret-escrow restore drilled.

## 6. What is discarded (explicit, so nobody "ports" it later)

CSS skin accretion, `*Ultimate` forks, per-domain job/content/retry systems,
polling clients, companion script duplication, install-script sprawl, repair
scripts, string-match provider bans, scattered guest denylists, hidden timers,
static concurrency caps, opaque `settings_json` junk drawers, HTTP-layer string
aliases, unregistered route primaries.

## 7. Risk register

| Risk | Mitigation |
|---|---|
| Porting pressure ("just copy the loop") | Import-lint + case-first rule; reviewers reject bulk ports |
| Plugin contract too weak (Investigation doesn't fit) | Investigation is phase D1 *because* it stress-tests the contract; contract revs are expected |
| Registry boot-validation too strict (dev without keys) | Explicit `unconfigured` tolerance is a declared state, not an accident — dev boots with mocks by declaration |
| Event-driven rewrite stalls on delivery semantics | At-least-once + idempotent consumers is the documented contract from day one; no exactly-once promises |
| Secret escrow becomes a second secret store | Escrow shares, not copies; restore drilled, access audited |

## 8. Milestone acceptance (overall)

vNext replaces the reference when: all 12 Nexus contract cases pass against
real modules; Investigation runs end-to-end as a plugin; a project survives
backup→destroy→restore including secrets; routing changes are eval-gated;
and no module violates the dependency rules in `docs/DOMAIN-BOUNDARIES.md`.
