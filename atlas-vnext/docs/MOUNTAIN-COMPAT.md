# Mountain behavioural compatibility gate

Atlas vNext architecture is unchanged: **Nexus owns WHERE** (registry, aliases, ranking, health/cost/privacy, immutable `RouteDecision`); **Execution owns HOW** (transport, streaming, retries, circuit breaking, failure classification). This document locks *externally meaningful* Mountain semantics as contracts + tests. It is not a Mountain port.

Classification vocabulary used below:

| Label | Meaning |
|---|---|
| **VERIFIED FROM CURRENT MOUNTAIN** | Quoted against `ocrowleymatt-stack/atlas-mountain` current `main` @ `5cc7a964…`. SHA confirmed by live inspection on the user's side; implementing files quoted from that same tree in the census |
| **VERIFIED FROM HISTORICAL MOUNTAIN** | Inspected against a dated Mountain tree that is **not** current `main` (path + SHA) |
| **SUPERSEDED BY CURRENT MOUNTAIN** | Historical Mountain behaviour later replaced on Mountain `main` (requires a current-tree citation) |
| **USER REQUIREMENT NOT PRESENT IN MOUNTAIN** | Required for vNext; not found in the inspected Mountain sources (tree @ `5cc7a964…` or issue #172) |
| **DISCARD** | Must not be carried into vNext (wrong tree, architecture, or silent-failure mode) |
| **UNKNOWN / NOT VERIFIED** | Could not be confirmed from a Mountain file, issue, PR, or commit |

## Inspection provenance (this run)

The private TypeScript repository **is** `ocrowleymatt-stack/atlas-mountain`. It is the primary behavioural reference. `lystrosaurus/atlas-mountain` (Java/Spring Boot) is **not** Atlas Mountain (**DISCARD**).

This Cloud Agent GitHub App installation can only see `ocrowleymatt-stack/flipper-marauder-ai` (`GET /installation/repositories`). `gh repo view ocrowleymatt-stack/atlas-mountain` and `git clone` therefore return GitHub’s “not found” for an unauthorized private repo. That is **token scope**, not evidence that the repository is missing. **Do not** treat that 404 as “the repo does not exist.”

Current Mountain `main` and issue **#172** were **not** re-cloned or opened by this agent. They were confirmed by live inspection **on the user's side**. Implementing file paths were confirmed from the `5cc7a96` tree already in the census. Dual provenance:

| Source | Status this run |
|---|---|
| Current Mountain `main` SHA | **VERIFIED FROM CURRENT MOUNTAIN @ `5cc7a964059d3f6583bb5a8284f85185c86f1cb1`.** The user verified the live `ocrowleymatt-stack/atlas-mountain` branch. This SHA is current `main`, not a historical snapshot. |
| Mountain issue **#172** “Recover tenant-safe Behaviour / Open posture” | **VERIFIED as Mountain** (not reconstructed user notes). The user read the live issue. This agent did not open it via GitHub API. |
| Implementing files at that SHA | **Confirmed from the `5cc7a96` tree already in the census** (design-gate `cursor/atlas-vnext-design-gate-057e`, `d33bc5f`). That agent had a read-only clone at `/agent/repos/atlas-mountain`. File paths, line counts, and test names below are quoted from that census, not invented this run. An earlier read-only census inspected this same tree without recognising it was still current `main`. |
| Mountain PR **#221** | **UNKNOWN / NOT VERIFIED.** Not opened this run; not independently confirmed on the user's side. |
| Existence of the private TS repo | **Verified independently:** Caspa `deployment/atlas-mountain-oidc/deploy-artifact-runner.sh` (`REPO='ocrowleymatt-stack/atlas-mountain'`); Caspa `deployment/atlas-mountain-oidc/receiver.mjs` (`ocrowleymatt-stack/atlas-mountain/.github/workflows/provision-runpod-music.yml`). |
| `/tmp/ref/atlas-mountain` | **DISCARD.** Remote `lystrosaurus/atlas-mountain` Java/Spring Boot stub. |
| Caspa (`/tmp/ref/Caspa`, historically `55ea409`) | **Inspected** as adjacent Atlas consumer: `src/services/routerFailover.ts`, `docs/ROUTER_FAILOVER_DESIGN.md`, `docs/NEXUS_RECOVERY.md`. Structure **not copied**. |
| `ocrowley-commons` | **Inspected** as adjacent: `@ocrowley/ai-client` mixes policy + HTTP — **DISCARD as structure**. |
| vNext `main` @ `ab13570` (PR #4) | **Inspected:** broker failover-before-output, tool-call buffer, Forge-before-RunPod ranking, local-only privacy, host catalogue `grok-build` → upstream `grok-build-0.1`. |

No Mountain files were copied into this repository.

### Mountain issue #172 (user-verified contents)

Issue **#172** is a genuine Mountain requirement. It explicitly requires:

- Standard/Open Behaviour posture
- Behaviour remains separate from Authority/tool permissions
- tenant-specific persistence and isolation
- invalid modes fail closed
- private/local-only routing remains local-only
- Open changes response/provider posture, not authority
- current health/performance/failover routing remains authoritative
- no resurrection of old router architecture

Cite **#172** as the Mountain source for those items. Implementing files on current main @ `5cc7a964…` (census): `behaviour/`, `permissions/engine.ts`, `tenancy/database-router.ts`, `behaviour/posture-store.ts`, local-only routing, failover. Do not invent paths not already in the census.

## What Mountain structure is deliberately not copied

Quoted current-main paths exist only as behavioural citations:

- `services/nexus` Fastify god-service
- `services/nexus/src/providers/router.ts` composition root (routing + cooldowns + failover injection)
- keyword `auto-router.ts` / `auto-workspace-router.ts` layers
- `hetzner/chat` as `nexus/instant` primary **without** a registered adapter (silent OpenAI fallback — **DISCARD** that failure mode)
- per-dungeon RunPod clients, nginx `/v12`, string-needle contract scripts

vNext keeps: Nexus = WHERE; Execution = HOW; shared runtime scheduler owns scarce capacity; Dungeons remain isolated consumers. Issue **#172** forbids resurrecting the old router architecture.

## Compatibility requirements

### 1. Failover before output / never after output

**Classification:** **VERIFIED FROM CURRENT MOUNTAIN @ `5cc7a964…`** (`services/nexus/src/providers/failover-provider.ts`, tests `failover-provider.test.ts`, `streaming.test.ts`). Mountain issue **#172** requires current health/performance/failover routing to remain authoritative.

Census behaviour: pre-output retry then chain failover; “visible-text emission commits to the current provider (no double-answer on partial streams).”

vNext preserves the rule in `ExecutionBroker` (no provider switch after visible assistant **text or reasoning**). Treating reasoning as visible is a **conservative vNext extension**, not a quoted Mountain line. Architecture of `FailoverProviderAdapter` is **not copied**.

### 2. Transactional tool-call buffering

**Classification:** **VERIFIED FROM CURRENT MOUNTAIN @ `5cc7a964…`** (`failover-provider.ts`: “tool-call chunks buffered until successful completion”).

vNext preserves: buffer until the attempt succeeds; failed attempts must not emit or execute fragments (`OpenAIToolCallAssembler` + broker buffer). Mountain SSE parsers are **not copied**.

### 3. Transient retry classification

**Classification:** **VERIFIED FROM CURRENT MOUNTAIN @ `5cc7a964…`** for the taxonomy in `provider-error.ts`: retryable `timeout\|unavailable\|abrupt_end`; terminal `invalid_request\|context_length\|cancelled`. HTTP 429/5xx as transient is **USER REQUIREMENT NOT PRESENT IN MOUNTAIN** as an inspected line (Caspa `routerFailover` billing/transient cooldowns are adjacent, **not copied**).

vNext maps timeout/reset/429/5xx → transient; 400/401/unsupported/permission/context overflow/cancelled → terminal. Bounded per-candidate attempts. Mountain `immune-system.ts` tool retry is a **separate** layer (**DISCARD as broker structure**).

### 4. Local-only / Private routing

**Classification:** **VERIFIED FROM CURRENT MOUNTAIN @ `5cc7a964…`** (`capability-router.ts` / `nexus/private`: `localOnly` filter `localProviders = {ollama, mock}`, empty fallback chain; tests `venice-local-routing.test.ts`). Mountain issue **#172** requires private/local-only routing remains local-only.

Alias `nexus/private` is **SUPERSEDED** in vNext naming by `nexus/local` + `privacy: local_only`. Semantics preserved: never select `public_cloud`; missing local **fail closed**. Public xAI/Grok **must not** satisfy `local_only` because it is a strong reasoner.

Forge/Hetzner was **owned private capacity**, not the private/local-only filter (`localProviders` did not include hetzner/forge). vNext likewise excludes `private_cloud` from `local_only`.

### 5. Behaviour ≠ Authority

**Classification:**

- **VERIFIED FROM CURRENT MOUNTAIN @ `5cc7a964…`** as *module separation*: `permissions/engine.ts` vs `behaviour/` (store/resolver/prompt, migration `0027`); tests `permissions.test.ts`, `behaviour-posture.test.ts`, `behaviour-routes.test.ts`. Census §16: posture prompting “mixes policy with persona”; §25: “persona prompting must not live beside permission enforcement.”
- Standard/Open Behaviour posture; Behaviour remains separate from Authority/tool permissions; Open changes response/provider posture, not authority (Open grants no extra filesystem/shell/network/publishing/compute/admin): **VERIFIED FROM MOUNTAIN issue #172**. Implementing files as above.
- Mountain PR **#221**: **UNKNOWN / NOT VERIFIED**.

vNext preserves the boundary in fail-closed stubs: Open changes **response posture only**; Authority stays the permission gate. Mountain `behaviour/` UI and SQLite are **not copied**.

### 6. Tenant-isolated Behaviour persistence

**Classification:**

- Per-tenant DB routing: **VERIFIED FROM CURRENT MOUNTAIN @ `5cc7a964…`** (`tenancy/database-router.ts`, `behaviour/posture-store.ts`, `sso-tenancy.test.ts`).
- Tenant-specific persistence and isolation; invalid modes fail closed: **VERIFIED FROM MOUNTAIN issue #172**. Implementing files as above. Census tenant DBs corroborate isolation as a Mountain *direction*; the vNext stub API is not a copy of Mountain SQLite.

vNext stub: in-memory `TenantBehaviourStore`, missing tenant/row → `standard`, cross-tenant throws, Zod-invalid modes throw **before** persist.

### 7. Behaviour prompt composed with capability / runtime policy

**Classification:** **VERIFIED FROM CURRENT MOUNTAIN @ `5cc7a964…`** that posture prompts and mode-policy coexisted (`behaviour/` + `agent/mode-policy.ts`). Census §23 weakness: “posture/persona and retrieval policy interleave … with no precedence contract.” Mountain issue **#172** requires Open to change response/provider posture, not authority, and current health/performance/failover routing to remain authoritative. vNext fail-closed compose (posture cannot replace capability/runtime policy) implements that #172 rule; it does **not** copy the census-noted interleaving.

### 8. Auto / Power-Pod specialist/fallback (owned capacity before burst GPU)

**Classification:** **VERIFIED FROM CURRENT MOUNTAIN @ `5cc7a964…`** (`auto-router.ts`, `hybrid-auto-policy.ts` “Power-Pod-first planning for `auto/route`”, `autoPowerPodFailover` in `router.ts`, tests `hybrid-auto-policy.test.ts`, `hetzner-auto-routing.test.ts`, `legacy-auto-targets.test.ts`). Keyword auto layers: **DISCARD as structure** (issue **#172**: no resurrection of old router architecture; redesign into Nexus ranking).

vNext: `auto` / `power-pod` are **not** `ALIAS_POLICIES` keys. Specialist/fallback ranking prefers local → private_hosted Forge → expensive_burst RunPod. That is vNext data, mapping current-main “owned capacity first when healthy.”

### 9. Route observability (attempts and rejects, not only the winner)

**Classification:** **VERIFIED FROM CURRENT MOUNTAIN @ `5cc7a964…`** that a performance ledger and traces existed (`providers/performance.ts` `rankCandidatesByPerformance`, `agent/trace-store.ts`). Mountain issue **#172** requires current health/performance/failover routing to remain authoritative. Census §20: no correlation id joining message → route → provider calls. vNext `rejectedCandidates` + execution `onAttempt` is a **vNext improvement** on that surface, not a Mountain copy.

### 10. Deployment / resource hygiene (bounded retention)

**Classification:** **VERIFIED FROM CURRENT MOUNTAIN @ `5cc7a964…`** that storage pressure was a live concern: census §9, commit `5cc7a96` itself described as “recover Website Studio from storage pressure”; `ops/website-studio/cleanup-dev-sites.sh`. Numeric vNext caps (`DEFAULT_RETENTION_BOUNDS`) are **USER REQUIREMENT NOT PRESENT IN MOUNTAIN** (not Mountain’s numbers). CAS prune jobs remain deferred stubs.

## `nexus/reason` and `grok-build` (not a Mountain alias)

**Classification:** **USER REQUIREMENT NOT PRESENT IN MOUNTAIN** for “always route `nexus/reason` to grok-build.” Mountain @ `5cc7a964…` (census §1 / original Nexus contract table): `nexus/reason` primary was **anthropic**, fallbacks openai → owned → gemini → venice. xAI lived as Vault + bespoke `src/xai/routes.ts` (`grok-4.6` default), **not** a `ProviderAdapter`, **not** the reason primary.

vNext **does not resurrect** that capability table. Nexus ranks registered reasoning models by runtime class then latency. The host catalogue aliases `grok-build` → upstream `grok-build-0.1` (fast reasoning), so when xAI is healthy it wins `nexus/reason` — that is **vNext catalogue ranking**, verified against `apps/host/src/catalogue.ts` and `apps/host/tests/spine.test.ts`, not a Mountain contract.

Mountain-compat tests must still prove: **`privacy: local_only` never selects public xAI/Grok** (issue **#172**). Auto still prefers local/Forge over RunPod even when grok-build is registered.

## Forge / Hetzner

**Classification:** **VERIFIED FROM CURRENT MOUNTAIN @ `5cc7a964…`** as *policy*, not as a first-class adapter (census §7): `nexus/instant` primary `hetzner/chat` had **no** adapter in `configureProviders`; Forge credentials via `provider-connections/routes.ts`; deploy `deploy/hetzner/`. **DISCARD** the unregistered-primary gap. vNext: one provider id `forge` (Hetzner is the host). Owned-first = `private_hosted` before `expensive_burst`.

## RunPod / Power-Pod

**Classification:** **VERIFIED FROM CURRENT MOUNTAIN @ `5cc7a964…`** (`compute/governor.ts`, `runpod-*.mjs`, `hybrid-auto-policy.ts`; census: generic `runpod` chat id referenced but not registered — same integrity gap). vNext: RunPod is scarce `expensive_burst` capacity on the shared scheduler, last when local/private can satisfy. Per-dungeon RunPod clients **DISCARD**.

## What this change does not do

- No PostgreSQL product migration, extra providers, RunPod product features, Writing, Website Studio, OSINT, or Dungeons as product.
- No bulk-copy of Mountain / Caspa routers.
- No replacement of the Nexus/Execution split.
- No claim that this Cloud Agent cloned Mountain or opened issue #172 / PR #221 itself. Current SHA and #172 contents were confirmed by live inspection on the user's side; implementing files were confirmed from the census tree at that SHA.
- Full Behaviour product UI, durable tenant DB, and CAS prune jobs remain **implementation deferred** — locked by fail-closed stubs + tests.
