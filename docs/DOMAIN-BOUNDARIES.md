# Atlas vNext — Domain Boundaries

Boundaries first, cosmetics never. Each domain below names its **owner**, its
**public contract**, what it may depend on, and what is explicitly **not** its
job. Anything not listed here does not get its own service, store, or retry
loop. Census references (`§N`) point at `docs/CAPABILITY-CENSUS.md`.

---

## Boundary map

| Domain | Owner | Public contract |
|---|---|---|
| Routing (Nexus) | `services/nexus` | `NEXUS-CONTRACT.md`: resolve-only |
| Execution | `services/broker` | run intents, tools, jobs; emit events |
| Provider registry | broker-owned module | `can-serve()` + chain validation |
| Durable jobs + events | broker-owned substrate | `JOBS-AND-EVENTS.md` |
| Content + durable state | `packages/storage` | `STORAGE-MODEL.md` |
| Permissions | broker choke point | capability checks + suspension |
| AuthN / sessions / tenancy | `services/edge` + core session module | session → capabilities |
| Dungeons (Investigation, Writing, Quantum, Music, Website Studio…) | plugins via `plugin-sdk` | plugin contract (§7) |
| Skills | versioned prompt packs via registry | skill manifest format |
| OSINT engines | broker tool plugins | uniform evidential envelope |
| Compute pool (RunPod/owned) | broker workload classes | one pool, classes, priorities |
| Device relay | edge + broker jobs | one relay protocol |
| UI shell | `apps/shell` | renders core; dungeon UI via contract |
| Deploy | `deploy/` transactional deployer | canary + verify + rollback |
| Observability/eval | built-in (correlation id + ledger + `packages/eval`) | trace + metrics + eval gates |

---

## 1. Nexus (router) — owns *decisions*, never *effects*

- **Owns:** ingress normalization, capability table (data), policy assembly
  (persona/posture/retrieval gating inputs), budget checks, handoff construction.
- **May depend on:** `packages/contracts`, provider registry (read-only
  lookup), project context (read-only).
- **Must not:** call vendors, execute tools, run loops/threads/timers, own
  queues, touch blobs, keep retry state. No vendor SDKs in its dependency
  closure (import-lint enforced).
- **Why:** every "smart router" accretes execution until it is untestable.
  The census shows this happened once (§1, §2); the boundary makes it
  structurally impossible.

## 2. Execution broker — owns *effects*, never *routing policy*

- **Owns:** provider invocation with the failover contract, tool execution,
  job pool, fan-out (deep/adversarial), permission choke point, event emission,
  compute-pool scheduling, provider registry (write side: health, cooldowns,
  perf ledger).
- **May depend on:** contracts, plugin-sdk, storage, registry.
- **Must not:** choose capabilities, assemble user-facing policy prompts, serve
  UI, own dungeon domain logic (it *hosts* plugins; it does not *contain*
  investigation or writing logic).
- **Why:** one place where side effects happen means one place to audit,
  trace, permission-gate and recover.

## 3. Provider registry — one owner of "can X serve?"

- Merges health probes (§3), runtime cooldowns and performance signals.
- Read path serves Nexus resolution; write path ingests broker outcomes.
- Boot-time chain validation lives here: unresolvable capability = refused boot.
- Explicit routing is strict: named provider or named error, never silent
  substitution.

## 4. Permissions — capability checks at the broker boundary

- AuthN (who is this session, which tenant) is resolved at the edge/core
  session layer; permissions (may this call happen) are enforced at the broker
  choke point for *every* side-effecting call: tools, provider calls with
  side effects, job enqueue, device actions, publication.
- Human suspension (§16) is a broker primitive: pending decisions suspend the
  execution, with timeouts, and resume or abort on decision. No domain
  reimplements waiting.
- Guest/owner profiles are capability sets, not scattered denylists: the
  registry denylist pattern in the legacy `tools/registry.ts` is abolished.

## 5. AuthN / sessions / tenancy — edge + core, not per-domain

- Edge gateway: pairing, session cookies/tokens, rate limits, loopback proxy.
  Preserves the loopback-core + authenticated-edge topology (§15).
- Core session module: session → tenant → capability set; per-tenant state
  isolation (the `database-router.ts` idea, generalized).
- Native/device auth (Atlas OS vault key layer, safety actions) talks to the
  same session boundary; device capabilities arrive over the relay protocol
  as broker tools, not as parallel auth stacks.
- Breakglass/forward-auth debris is not ported; emergency access is a
  documented, tested procedure in the deploy domain.

## 6. Content + durable state — `packages/storage` + relational core

- Full model in `docs/STORAGE-MODEL.md`. Boundary rule: **no domain stores
  bytes or rows outside these two substrates.** Projects, conversations,
  attachments, artifacts, jobs, traces, ledgers (claims, audit, assurance),
  vault secrets and snapshots all sit on them.
- Vault pattern (encrypted-at-rest, fingerprint metadata, hardened key file
  **plus key escrow/backup**) is the only approved secret store.

## 7. Dungeons — plugins, not services

A dungeon (Investigation, Writing/Caspa-adjacent, Quantum, Music, Website
Studio, future) is a **plugin** implementing the plugin-sdk contract:

- **Contributes:** tools (versioned, schema-validated IO), job handlers
  (against the durable-job substrate), prompt packs (skill format), UI panels
  (against the shell's UI contract), event subscriptions.
- **Owns:** its domain logic and its evidential/provenance rules (e.g. claim
  ledger semantics stay in Writing; assurance rules stay in Investigation).
- **Must not own:** queues, stores, retry policy, schedulers, auth, preview
  serving, GPU clients. Investigation's private scheduler, writing's
  headless-worker pool and studio's preview server all dissolve into platform
  substrates.
- **Reference plugin:** Investigation is rebuilt first as the proof that the
  contract suffices (§11); its run-contract/recovery semantics graduate into
  platform job semantics.
- **Caspa relationship:** Caspa remains external; it integrates as a consumer
  of jobs/events/storage behind versioned contracts — the same direction it
  already took with the recovery fabric — never as a fork of internals.

## 8. Skills — versioned prompt packs

- The `SKILL.md` + manifest format ports as the unit of specialist prompting.
- Distribution moves to a registry (versioned, signed, capability-scoped):
  skills declare required tools/capabilities; the broker enforces the
  declaration at execution time.
- Debugging/fact-check/deep-research skills become eval-adjacent prompt packs
  with measurable acceptance cases, not folklore.

## 9. OSINT engines — broker tool plugins with a uniform envelope

- Brave/Kagi/Exa/Searxng federation + RRF, tracking-param hygiene and public-target
  gating port as engine plugins.
- Uniform evidential envelope (source, retrieved-at, evidential status) on
  **every** result regardless of call path — closing the ad-hoc-vs-pipeline gap (§10).

## 10. Compute pool — one pool, workload classes

- RunPod/owned/GPU capacity is one broker-scheduled pool with workload classes
  (interactive inference, batch, writing-GPU, music, classical compute) and
  priorities — not four faces with four config schemes (§6).
- "Owned capacity first" is registry priority data consumed by resolution, not
  special-case branches in routing code (§7).
- Deterministic/classical compute (the COMPUTE_FABRIC invariant: shared
  infrastructure, not dungeon-owned) stays shared; dungeons submit work, they
  do not operate workers.

## 11. Device relay — one protocol

- Companion scripts, device relay and Atlas OS modules converge on a single
  relay protocol: capability advertisement, job submission, result/event return.
- Safety-critical device actions (lock/seal) remain operable without
  network/LLM — a device-side invariant the protocol must not violate.

## 12. UI shell — thin host, dungeon panels by contract

- Shell owns: conversations, projects, permissions/activity surfaces, model
  selection, pairing/login. It renders dungeon panels through a UI contract
  (panel registration, data queries, actions) — dungeons never fork the shell.
- The `*Ultimate` fork pattern and theme-by-accretion skins are abolished; one
  design system, dungeon branding as data.

## 13. Deploy — a single tested transaction

- One deployer with plan/apply/verify/rollback, canary gates and pytest-style
  regression — preserving the *practice* (§19) while deleting script sprawl,
  repair scripts and string-match policy hacks (policy becomes versioned
  config + tests).

## 14. Observability/eval — built in, not bolted on

- Correlation id from ingress to every broker attempt, tool call and job event.
- Durable perf ledger feeds the registry; traces feed debugging; eval harness
  (`packages/eval`) gates routing changes. No new heuristic without a measured
  baseline.

---

## Dependency rules (enforced, not advised)

1. `services/nexus` → `packages/contracts`, registry read API, project-context
   read API. Nothing else.
2. Dungeon/skill/tool plugins → `plugin-sdk` + `contracts` only. Direct imports
   of broker internals, storage internals or each other are forbidden.
3. Cross-domain communication happens via **jobs, events, or versioned
   contracts** — never direct function calls between dungeon code.
4. Vendor SDKs appear only in broker adapter modules behind the provider SPI.
5. Storage internals are touched only by `packages/storage`; everyone else uses
   its API.
