# Atlas vNext — Architecture

Atlas vNext is a clean rebuild. Atlas Mountain (`../atlas-mountain`) is a
behavioural reference: we preserve its proven correctness properties and port
its test *cases*, but no file is copied wholesale and no legacy module boundary
is treated as authoritative. The governing question for every design choice is:
*what is the smallest boring structure that preserves the behaviour?*

Companion documents: `docs/REPOSITORY-AUDIT.md` (exact audit scope and
non-Mountain discoveries), `docs/CAPABILITY-CENSUS.md` (what exists),
`docs/PORT-REDESIGN-DISCARD.md` (explicit decisions),
`docs/DOMAIN-BOUNDARIES.md` (who owns what), `docs/STORAGE-MODEL.md` (how
state persists), `docs/JOBS-AND-EVENTS.md` (how background work runs),
`docs/NEXUS-CONTRACT.md` (the router/broker contract + test cases), and
`docs/MIGRATION-PLAN.md` (how we get there).

---

## 1. Non-negotiable architectural rules

1. **Small, boring Nexus router.** Nexus resolves *what should handle this
   request* (capability → ordered provider chain) and nothing else. It owns no
   retry loops, no threads, no polling, no domain logic. If a behaviour needs a
   loop, it lives in the broker or a plugin — never in the router.
2. **Separate execution broker.** All side effects — provider calls with
   retry/failover, tool execution, job execution, fan-out — run in the broker
   behind one interface. The router decides; the broker does.
3. **Single provider registry.** Health, cooldowns, performance signals and
   configuration resolve in exactly one place. A capability whose chain is
   unresolvable at startup fails loud at boot, never silent at runtime (this
   closes the `hetzner/chat` stale-primary gap found in the census).
4. **One durable-job substrate.** Research jobs, investigation runs, writing
   commissions and device-relayed work are all jobs. No domain owns its own
   queue, poll loop or recovery story.
5. **One content store.** Attachments, artifacts, ingests, captures, snapshots
   and site previews are views over a single content-addressed store with a
   uniform provenance envelope.
6. **Capability-based permissions at one choke point.** Every side-effecting
   call passes the broker's permission check. The human-suspension semantic
   (the loop waits for a decision) applies uniformly.
7. **Provenance before prose.** Anything the system asserts — a claim, a
   finding, an OSINT lead, a billed action — carries source, retrieval time and
   evidential status. Ad-hoc tool calls get the same envelope as pipeline
   results.
8. **Redaction and tenancy by construction.** Secret redaction at the logger
   root, loopback-only core with an authenticated edge, per-tenant state
   isolation — day-one properties, not hardening sprints.
9. **Correlated observability.** One correlation id joins message → route
   decision → provider attempts → tool executions → job events. Logs, traces
   and the performance ledger are three views of one trace, not three systems.
10. **Deployment as a tested transaction.** Canary + verify + rollback for every
    release; contract gates are runnable tests, not shell-script folklore.

---

## 2. System shape

```text
                    ┌─────────────┐
                    │  UI shell   │  desktop / PWA / device
                    │ (thin host) │
                    └──────┬──────┘
                           │ HTTPS/SSE (edge)
              ┌────────────▼────────────┐
              │      Edge gateway       │  auth, pairing, rate limits,
              │  (authenticated edge)   │  loopback proxy to core
              └────────────┬────────────┘
                           │ loopback only
        ┌──────────────────▼──────────────────┐
        │                NEXUS                │  SMALL/BORING ROUTER
        │  ingress → normalize → resolve     │  - target normalization (once)
        │  capability → ordered chain        │  - capability table
        │  policy (persona/posture/retrieval)│  - registry lookup
        │  NO loops, NO retries, NO threads  │  - handoff to broker
        └──────┬───────────────────┬──────────┘
               │ handoff           │ handoff
   ┌───────────▼──────┐  ┌─────────▼───────────┐
   │  Execution broker │  │   Provider registry │  config + health +
   │  - provider calls │  │   (single owner of  │  cooldowns + perf
   │    retry/failover │  │   "can X serve?")   │
   │  - tool execution │  └─────────────────────┘
   │  - job execution  │
   │  - fan-out (deep/ │
   │    adversarial)   │
   │  - permission     │
   │    choke point    │
   └──┬─────┬─────┬────┘
      │     │     │
      ▼     ▼     ▼
   plugins jobs  store
   (dungeons,   (durable   (content-
    skills,      substrate  addressed,
    tools,       + events)  provenance-
    adapters)               enveloped)
```

**Request path (chat).** Edge validates session → Nexus ingress normalizes the
target once against the registry, assembles policy (persona, posture,
retrieval gating), and hands an execution intent to the broker → broker checks
permissions (suspending for human decisions), runs the provider chain with the
failover contract, executes approved tool calls, streams events → Nexus formats
the stream to the client. Nexus never calls a provider or a tool directly.

**Background path (jobs).** Any domain enqueues a job; the broker pool
executes it with idempotency keys, heartbeats, cancellation and recovery;
progress and completion are events, never polled rows.

---

## 3. Nexus critical requirements (router discipline)

- Pure resolution: `(target, context) → {capability, ordered chain, policy}`.
  Deterministic given registry state; no I/O except the registry lookup.
- Single target normalization. String aliases (`auto`, `nexus/auto`) die at
  ingress; downstream only sees canonical capability ids or explicit routes.
- Capability table is data (ids, primaries, fallbacks, `localOnly`,
  priority), not code. "Owned capacity first" is a registry priority, not a
  special-case branch.
- Boot-time chain validation: every capability primary + fallback must resolve
  to a registered adapter or an explicitly-tolerated unconfigured state;
  otherwise refuse to boot with a named error.
- Budget enforcement: context/token limits and idle budgets are checked at
  handoff construction, before the broker spends anything.

## 4. Execution broker requirements

- Owns the failover contract verbatim from the census: transactional
  tool-call buffering, no provider switch after visible text, bounded transient
  retries, terminal-error taxonomy.
- Single permission choke point for all side effects, with human suspension.
- Tool execution through versioned plugin interfaces; unknown tool ids fail
  closed.
- Correlated tracing: every attempt, tool call and job event carries the
  request/job correlation id.

## 5. Provider registry requirements

- Merges today's three views (health probes, runtime cooldowns, performance
  ledger) into one `can-serve(provider, capability)` answer with reasons.
- Four-state health model preserved: `healthy / configured /
  authentication_failure / unavailable`.
- Durable performance ledger (survives restarts, shared across instances).
- Explicit provider routing: a request naming a provider gets that provider or
  a named error — never silent substitution.
- Local-only enforcement by construction (`nexus/private`-style constraints
  are registry filters, not prompt instructions).

---

## 6. Target monorepo shape

```text
atlas-vnext/
  ARCHITECTURE.md
  docs/
    CAPABILITY-CENSUS.md
    DOMAIN-BOUNDARIES.md
    STORAGE-MODEL.md
    JOBS-AND-EVENTS.md
    NEXUS-CONTRACT.md
    MIGRATION-PLAN.md
  apps/
    shell/            # thin UI host: chat, projects, permissions, activity
    plugins-ui/       # dungeon-contributed panels via UI contract (or per-dungeon packages)
  services/
    nexus/            # small/boring router + ingress + policy assembly
    broker/           # execution broker: providers, tools, jobs, fan-out
    edge/             # authenticated gateway (mobile/pairing/rate limits)
  packages/
    contracts/        # shared types: routes, jobs, events, provenance, tool IO
    provider-spi/     # ProviderAdapter interface + error taxonomy + test harness
    plugin-sdk/       # dungeon/skill/tool plugin contract + UI contract types
    storage/          # content-addressed store + durable-state idiom
    eval/             # routing/eval harness (new scope)
  domains/
    investigation/    # reference plugin; isolated behind contracts + plugin-sdk
    writing/ quantum/ music/ website-studio/
  tests/
    nexus-contract/   # contract tests (node:test scaffold, see §8)
    contracts/        # schema invariants
    architecture/     # dependency/import boundary enforcement
  architecture-boundaries.json
  deploy/
    hetzner/ runpod/  # ONE transactional deployer + canary + verify
```

Notes:

- `services/nexus` must stay dependency-light: contracts + registry client +
  policy assembly. It must not depend on vendor SDKs, the job pool, or tool
  implementations. Enforce with an import-lint rule.
- Vendor adapters live in `services/broker` (or `packages/` provider
  implementations behind the SPI) — never in Nexus.
- `packages/contracts` is the single source of truth for every cross-service
  shape (route resolution, job records, event envelopes, provenance, tool
  definitions). It is versioned; breaking changes migrate, not fork.

---

## 7. Data and storage posture (summary)

Full design in `docs/STORAGE-MODEL.md`. In short: one content-addressed
blob store + one durable relational core (ordered migrations, per-tenant
isolation) + Vault-pattern encrypted secrets + explicit snapshot/backup with
tested restore (including key escrow — the census's sharpest gap).

## 8. Verification posture

- **Nexus contract tests** (`tests/nexus-contract/`, scaffolded this change):
  fast/reason/code/vision routes, explicit provider routing, unhealthy
  exclusion, failover, no double-answer on partial streams, tool requirements,
  context limits, local-only, cheapest. Full case list in
  `docs/NEXUS-CONTRACT.md`. These run dependency-free (`node --test`) so the
  contract is enforceable before any provider exists.
- **Ported behaviour cases** from the ~130-file atlas-mountain corpus land in
  owning packages as they are rebuilt (migration order in
  `docs/MIGRATION-PLAN.md`).
- **Contract gates as tests.** Every `check-*contract.mjs` shell ritual becomes
  a runnable test or it dies.
- **Architecture boundary tests.** `architecture-boundaries.json` is executable
  policy: Nexus has only the contracts dependency; domains may depend only on
  contracts and plugin-sdk; broker cannot depend on Nexus; vendor/domain/
  storage implementation imports are forbidden from Nexus.
- **Evaluation harness** (`packages/eval`) for routing intent classification —
  the keyword heuristics are not ported without measurement.

## 9. Explicit non-goals for vNext foundation

- No per-domain job stores, content stores, or retry philosophies — ever again.
- No route id without a registered adapter. No string-alias handling outside
  ingress. No tool registration outside the plugin contract.
- No UI fork per dungeon (`*Ultimate` pattern). No theme-by-accretion skins.
- No backup story that excludes the secret-encryption key.
