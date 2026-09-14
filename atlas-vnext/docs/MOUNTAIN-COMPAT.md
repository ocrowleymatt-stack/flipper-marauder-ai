# Mountain behavioural compatibility gate

Atlas vNext architecture is unchanged: **Nexus owns WHERE** (registry, aliases, ranking, health/cost/privacy, immutable `RouteDecision`); **Execution owns HOW** (transport, streaming, retries, circuit breaking, failure classification). This document locks *externally meaningful* Mountain semantics as contracts + tests. It is not a Mountain port.

Classification vocabulary used below:

| Label | Meaning |
|---|---|
| **VERIFIED FROM CURRENT MOUNTAIN** | Inspected against `ocrowleymatt-stack/atlas-mountain` current `main` in this run |
| **VERIFIED FROM HISTORICAL MOUNTAIN** | Inspected against a dated Mountain tree (path + SHA). Not re-opened as current `main` |
| **SUPERSEDED BY CURRENT MOUNTAIN** | Historical Mountain behaviour later replaced on Mountain `main` (requires a current-tree citation) |
| **USER REQUIREMENT NOT PRESENT IN MOUNTAIN** | Required for vNext; not found in the inspected Mountain sources |
| **DISCARD** | Must not be carried into vNext (wrong tree, architecture, or silent-failure mode) |
| **UNKNOWN / NOT VERIFIED** | Could not be confirmed from a Mountain file, issue, PR, or commit in this run |

## Inspection provenance (this run)

The private TypeScript repository **is** `ocrowleymatt-stack/atlas-mountain`. It is the primary behavioural reference. `lystrosaurus/atlas-mountain` (Java/Spring Boot) is **not** Atlas Mountain (**DISCARD**).

This GitHub App installation can only see `ocrowleymatt-stack/flipper-marauder-ai` (`GET /installation/repositories`). `gh repo view ocrowleymatt-stack/atlas-mountain` and `git clone` therefore return GitHub’s “not found” for an unauthorized private repo. That is **token scope**, not evidence that the repository is missing. Do not encode Mountain semantics from that 404.

| Source | Status this run |
|---|---|
| `ocrowleymatt-stack/atlas-mountain` current `main`, issues, PRs, commits | **UNKNOWN / NOT VERIFIED.** Installation token cannot read the private repo. Issue **#172** (“Recover tenant-safe Behaviour / Open posture”) and related PR **#221** were not opened. |
| Existence of the private TS repo | **Verified independently:** Caspa `deployment/atlas-mountain-oidc/deploy-artifact-runner.sh` (`REPO='ocrowleymatt-stack/atlas-mountain'`); Caspa `deployment/atlas-mountain-oidc/receiver.mjs` (`ocrowleymatt-stack/atlas-mountain/.github/workflows/provision-runpod-music.yml`). |
| Historical Mountain `main` @ `5cc7a96` | **VERIFIED FROM HISTORICAL MOUNTAIN** via design-gate `cursor/atlas-vnext-design-gate-057e` (`d33bc5f` census). That agent had a read-only clone at `/agent/repos/atlas-mountain`. File paths, line counts, and test names below are quoted from that census, not invented this run. |
| `/tmp/ref/atlas-mountain` | **DISCARD.** Remote `lystrosaurus/atlas-mountain` Java/Spring Boot stub. |
| Caspa (`/tmp/ref/Caspa`, historically `55ea409`) | **Inspected** as adjacent Atlas consumer: `src/services/routerFailover.ts`, `docs/ROUTER_FAILOVER_DESIGN.md`, `docs/NEXUS_RECOVERY.md`. Structure **not copied**. |
| `ocrowley-commons` | **Inspected** as adjacent: `@ocrowley/ai-client` mixes policy + HTTP — **DISCARD as structure**. |
| vNext `main` @ `ab13570` (PR #4) | **Inspected:** broker failover-before-output, tool-call buffer, Forge-before-RunPod ranking, local-only privacy, host catalogue `grok-build` → upstream `grok-build-0.1`. |

No Mountain files were copied into this repository.

## What Mountain structure is deliberately not copied

Quoted historical paths exist only as behavioural citations:

- `services/nexus` Fastify god-service
- `services/nexus/src/providers/router.ts` composition root (routing + cooldowns + failover injection)
- keyword `auto-router.ts` / `auto-workspace-router.ts` layers
- `hetzner/chat` as `nexus/instant` primary **without** a registered adapter (silent OpenAI fallback — **DISCARD** that failure mode)
- per-dungeon RunPod clients, nginx `/v12`, string-needle contract scripts

vNext keeps: Nexus = WHERE; Execution = HOW; shared runtime scheduler owns scarce capacity; Dungeons remain isolated consumers.

## Compatibility requirements

### 1. Failover before output / never after output

**Classification:** **VERIFIED FROM HISTORICAL MOUNTAIN** (`5cc7a96` `services/nexus/src/providers/failover-provider.ts`, tests `failover-provider.test.ts`, `streaming.test.ts`). Current Mountain: **UNKNOWN / NOT VERIFIED**.

Historical behaviour (census §2, quoted): pre-output retry then chain failover; “visible-text emission commits to the current provider (no double-answer on partial streams).”

vNext preserves the rule in `ExecutionBroker` (no provider switch after visible assistant **text or reasoning**). Treating reasoning as visible is a **conservative vNext extension**, not a quoted Mountain line. Architecture of `FailoverProviderAdapter` is **not copied**.

### 2. Transactional tool-call buffering

**Classification:** **VERIFIED FROM HISTORICAL MOUNTAIN** (`5cc7a96` `failover-provider.ts`: “tool-call chunks buffered until successful completion”). Current Mountain: **UNKNOWN / NOT VERIFIED**.

vNext preserves: buffer until the attempt succeeds; failed attempts must not emit or execute fragments (`OpenAIToolCallAssembler` + broker buffer). Mountain SSE parsers are **not copied**.

### 3. Transient retry classification

**Classification:** **VERIFIED FROM HISTORICAL MOUNTAIN** for the taxonomy in `5cc7a96` `provider-error.ts`: retryable `timeout\|unavailable\|abrupt_end`; terminal `invalid_request\|context_length\|cancelled`. HTTP 429/5xx as transient is **USER REQUIREMENT NOT PRESENT IN MOUNTAIN** as an inspected line (Caspa `routerFailover` billing/transient cooldowns are adjacent, **not copied**).

vNext maps timeout/reset/429/5xx → transient; 400/401/unsupported/permission/context overflow/cancelled → terminal. Bounded per-candidate attempts. Mountain `immune-system.ts` tool retry is a **separate** layer (**DISCARD as broker structure**).

### 4. Local-only / Private routing

**Classification:** **VERIFIED FROM HISTORICAL MOUNTAIN** (`5cc7a96` `capability-router.ts` / `nexus/private`: `localOnly` filter `localProviders = {ollama, mock}`, empty fallback chain; tests `venice-local-routing.test.ts`). Current Mountain: **UNKNOWN / NOT VERIFIED**.

Historical alias `nexus/private` is **SUPERSEDED** in vNext naming by `nexus/local` + `privacy: local_only`. Semantics preserved: never select `public_cloud`; missing local **fail closed**. Public xAI/Grok **must not** satisfy `local_only` because it is a strong reasoner.

Forge/Hetzner was **owned private capacity**, not the private/local-only filter (`localProviders` did not include hetzner/forge). vNext likewise excludes `private_cloud` from `local_only`.

### 5. Behaviour ≠ Authority

**Classification:**

- **VERIFIED FROM HISTORICAL MOUNTAIN** as *module separation*: `5cc7a96` `permissions/engine.ts` vs `behaviour/` (store/resolver/prompt, migration `0027`); tests `permissions.test.ts`, `behaviour-posture.test.ts`, `behaviour-routes.test.ts`. Census §16: posture prompting “mixes policy with persona”; §25: “persona prompting must not live beside permission enforcement.”
- Named Standard/Open modes, “Open grants no extra filesystem/shell/network/publishing/compute/admin,” and issue **#172** / PR **#221** text: **UNKNOWN / NOT VERIFIED** against Mountain (issue not readable). Treated as **USER REQUIREMENT NOT PRESENT IN MOUNTAIN** until current Mountain / #172 can be quoted.
- Current Mountain: **UNKNOWN / NOT VERIFIED**.

vNext preserves the user-required boundary in fail-closed stubs: Open changes **response posture only**; Authority stays the permission gate. Mountain `behaviour/` UI and SQLite are **not copied**.

### 6. Tenant-isolated Behaviour persistence

**Classification:**

- Per-tenant DB routing: **VERIFIED FROM HISTORICAL MOUNTAIN** (`5cc7a96` `tenancy/database-router.ts`, `behaviour/posture-store.ts`, `sso-tenancy.test.ts`).
- “Tenant A cannot read/write tenant B,” fail-closed default Standard, invalid modes fail closed: **USER REQUIREMENT NOT PRESENT IN MOUNTAIN** as quoted #172 text; **UNKNOWN / NOT VERIFIED** against issue #172. Historical tenant DBs corroborate isolation as a Mountain *direction*, not the stub API.
- Current Mountain: **UNKNOWN / NOT VERIFIED**.

vNext stub: in-memory `TenantBehaviourStore`, missing tenant/row → `standard`, cross-tenant throws, Zod-invalid modes throw **before** persist.

### 7. Behaviour prompt composed with capability / runtime policy

**Classification:** **VERIFIED FROM HISTORICAL MOUNTAIN** that posture prompts and mode-policy coexisted (`behaviour/` + `agent/mode-policy.ts`). Census §23 weakness: “posture/persona and retrieval policy interleave … with no precedence contract.” vNext fail-closed compose (posture cannot replace capability/runtime policy) is **USER REQUIREMENT NOT PRESENT IN MOUNTAIN** — it *corrects* that historical interleaving rather than copying it.

### 8. Auto / Power-Pod specialist/fallback (owned capacity before burst GPU)

**Classification:** **VERIFIED FROM HISTORICAL MOUNTAIN** (`5cc7a96` `auto-router.ts`, `hybrid-auto-policy.ts` “Power-Pod-first planning for `auto/route`”, `autoPowerPodFailover` in `router.ts`, tests `hybrid-auto-policy.test.ts`, `hetzner-auto-routing.test.ts`, `legacy-auto-targets.test.ts`). Keyword auto layers: **DISCARD as structure** (redesign into Nexus ranking). Current Mountain: **UNKNOWN / NOT VERIFIED**.

vNext: `auto` / `power-pod` are **not** `ALIAS_POLICIES` keys. Specialist/fallback ranking prefers local → private_hosted Forge → expensive_burst RunPod. That is vNext data, mapping historical “owned capacity first when healthy.”

### 9. Route observability (attempts and rejects, not only the winner)

**Classification:** **VERIFIED FROM HISTORICAL MOUNTAIN** that a performance ledger and traces existed (`5cc7a96` `providers/performance.ts` `rankCandidatesByPerformance`, `agent/trace-store.ts`). Census §20: no correlation id joining message → route → provider calls. vNext `rejectedCandidates` + execution `onAttempt` is **USER REQUIREMENT** / vNext improvement. Current Mountain: **UNKNOWN / NOT VERIFIED**.

### 10. Deployment / resource hygiene (bounded retention)

**Classification:** **VERIFIED FROM HISTORICAL MOUNTAIN** that storage pressure was a live concern: census §9, commit `5cc7a96` itself described as “recover Website Studio from storage pressure”; `ops/website-studio/cleanup-dev-sites.sh`. Numeric vNext caps (`DEFAULT_RETENTION_BOUNDS`) are **USER REQUIREMENT NOT PRESENT IN MOUNTAIN** (not Mountain’s numbers). CAS prune jobs remain deferred stubs.

## `nexus/reason` and `grok-build` (not a Mountain alias)

**Classification:** **USER REQUIREMENT NOT PRESENT IN MOUNTAIN** for “always route `nexus/reason` to grok-build.” Historical Mountain (`5cc7a96` census §1 / original Nexus contract table): `nexus/reason` primary was **anthropic**, fallbacks openai → owned → gemini → venice. xAI lived as Vault + bespoke `src/xai/routes.ts` (`grok-4.6` default), **not** a `ProviderAdapter`, **not** the reason primary.

vNext **does not resurrect** that capability table. Nexus ranks registered reasoning models by runtime class then latency. The host catalogue aliases `grok-build` → upstream `grok-build-0.1` (fast reasoning), so when xAI is healthy it wins `nexus/reason` — that is **vNext catalogue ranking**, verified against `apps/host/src/catalogue.ts` and `apps/host/tests/spine.test.ts`, not a Mountain contract.

Mountain-compat tests must still prove: **`privacy: local_only` never selects public xAI/Grok**. Auto still prefers local/Forge over RunPod even when grok-build is registered.

## Forge / Hetzner

**Classification:** **VERIFIED FROM HISTORICAL MOUNTAIN** as *policy*, not as a first-class adapter (`5cc7a96` census §7): `nexus/instant` primary `hetzner/chat` had **no** adapter in `configureProviders`; Forge credentials via `provider-connections/routes.ts`; deploy `deploy/hetzner/`. **DISCARD** the unregistered-primary gap. vNext: one provider id `forge` (Hetzner is the host). Owned-first = `private_hosted` before `expensive_burst`.

## RunPod / Power-Pod

**Classification:** **VERIFIED FROM HISTORICAL MOUNTAIN** (`5cc7a96` `compute/governor.ts`, `runpod-*.mjs`, `hybrid-auto-policy.ts`; census: generic `runpod` chat id referenced but not registered — same integrity gap). vNext: RunPod is scarce `expensive_burst` capacity on the shared scheduler, last when local/private can satisfy. Per-dungeon RunPod clients **DISCARD**. Current Mountain: **UNKNOWN / NOT VERIFIED**.

## What this change does not do

- No PostgreSQL product migration, extra providers, RunPod product features, Writing, Website Studio, OSINT, or Dungeons as product.
- No bulk-copy of Mountain / Caspa routers.
- No replacement of the Nexus/Execution split.
- No claim that current Mountain `main`, issue #172, or PR #221 were read in this run.
- Full Behaviour product UI, durable tenant DB, and CAS prune jobs remain **implementation deferred** — locked by fail-closed stubs + tests.
