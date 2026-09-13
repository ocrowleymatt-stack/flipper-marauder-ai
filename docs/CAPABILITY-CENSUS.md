# Atlas vNext — Capability Census

Behavioural reference: `ocrowleymatt-stack/atlas-mountain`, branch `main` at
`5cc7a96`, from a prior read-only local audit. Atlas Mountain was not reachable
from the current run, so this retained evidence was not silently presented as
a fresh checkout. Atlas Mountain is a **behavioural reference, not an
architectural template**: this census records *what works and what must be
preserved*, so vNext can re-derive clean boundaries instead of copying files.

`flipper-marauder-ai` is **this** repository (Atlas vNext, greenfield,
`README.md` only at census time) and is the only repository under `/workspace`.
The current run also audited every repository exposed by the GitHub owner,
including Caspa, ocrowley-commons, Life-os, Shakespeare-, craigs-navigator,
TheBigBrother, handsy-ios, and the empty handy-ios. Exact refs and the important
capabilities found outside Atlas Mountain are in `REPOSITORY-AUDIT.md`.

Legend for the **Verdict** column used in every section:

- **Port** — behaviour is sound; re-implement behind the new boundary with minimal redesign.
- **Redesign** — the need is real but the current shape fights the vNext boundaries; keep the contract, change the internals.
- **Merge** — two or more duplicate implementations exist; consolidate to one owner.
- **Discard** — do not carry forward (dead code, policy hack, superseded approach).

Test references below are paths under `atlas-mountain/services/nexus/src/tests/`
unless stated otherwise.

---

## 1. Model / provider routing

**Where it lives.**

- `services/nexus/src/providers/router.ts` (319 lines) — composition root: `configureProviders`, `resolveRoute`, `resolveAutoExecution`.
- `services/nexus/src/providers/capability-router.ts` (209 lines) — the capability table (`capabilityRouteConfigs`: `nexus/instant|reason|code|research|deep|adversarial|private|frontier|vision|experimental`), `resolveCapability`, `buildCapabilityRoutes`, `adapterForRoute`.
- `services/nexus/src/providers/auto-router.ts` (222 lines) — keyword/intent heuristic `autoCapabilityForPrompt` mapping prompts to capabilities.
- `services/nexus/src/providers/auto-workspace-router.ts` (143 lines) — workspace-aware variant.
- `services/nexus/src/providers/hybrid-auto-policy.ts` (130 lines) — `hybridAutoExecutionPlan`: Power-Pod-first planning for `auto/route`.
- `services/nexus/src/providers/multimodel-provider.ts` (191 lines) — `MultiModelProviderAdapter` (scout + lead synthesis for `nexus/deep`, `nexus/adversarial`).
- `services/nexus/src/agent/mode-policy.ts` (90 lines) — per-capability system prompts + tool filtering.
- Contract types in `packages/shared/src/index.ts` (567 lines): `ProviderRoute`, `RouteConfig`, `RouteResolution`, `CapabilityAlias`, `ModelTarget`.

**Duplicates.** Three overlapping "auto" layers: `auto-router` (intent classification), `auto-workspace-router` (workspace variant), `hybrid-auto-policy` (execution plan) — plus mode policy in the agent layer. They compose but their precedence is only documented in code, not in a contract.

**Strongest implementation.** `capability-router.ts` + `router.ts` together are the strongest: deterministic chain resolution over explicit routes, `localOnly` enforcement for `nexus/private`, capability availability (`available` flag) derived from configured adapters. This is the behaviour to preserve.

**Dependencies.** Provider adapters (`types.ts` + per-vendor files), performance ledger (`performance.ts`), cooldown map in `router.ts`, `@atlas/shared` contract types.

**Weaknesses.** (a) Routing, failover, cooldowns, performance ranking and multimodel fan-out all live in one dependency knot around `router.ts` — the exact "fat router" vNext must split. (b) Intent classification is keyword heuristics with no evaluation harness. (c) `nexus/instant` primary is `hetzner/chat`, a route id with **no adapter registered in `configureProviders`** — it only resolves when some out-of-band registration happens (see §11); otherwise Instant silently falls to OpenAI. Stale primaries are invisible.

**Tests worth preserving.** `router.test.ts`, `capability-routing.test.ts`, `auto-router.test.ts`, `hybrid-auto-policy.test.ts`, `multimodel-provider.test.ts`, `hetzner-auto-routing.test.ts`, `legacy-auto-targets.test.ts`, `osint-owned-routing.test.ts`, `venice-local-routing.test.ts`.

**Verdict: Redesign (split) + Merge.** Keep the capability table and resolution semantics; merge the three auto layers into one intent step owned by Nexus; split execution (failover, cooldown, fan-out) into the broker (see `docs/NEXUS-CONTRACT.md`).

---

## 2. Retries / failover / streaming

**Where it lives.**

- `services/nexus/src/providers/failover-provider.ts` (144 lines) — `FailoverProviderAdapter`: pre-output retry (2 transient attempts, linear backoff) then chain failover; **tool-call chunks buffered until successful completion**, visible-text emission commits to the current provider (no double-answer on partial streams).
- `services/nexus/src/providers/provider-error.ts` (72 lines) — `ProviderError` taxonomy (`timeout|unavailable|abrupt_end` retryable; `invalid_request|context_length|cancelled` terminal).
- `services/nexus/src/providers/provider-http.ts` (237 lines) — shared SSE/stream parsing, diagnostics.
- `services/nexus/src/providers/performance.ts` (190 lines) — TTFT/latency/failure ledger feeding `rankCandidatesByPerformance`.
- `services/nexus/src/streaming/stream-registry.ts` (84 lines) + `sse-heartbeat.ts` (18 lines) — server-side stream bookkeeping.
- Agent-level retry: `services/nexus/src/agent/immune-system.ts` (128 lines) — `executeWithImmuneRetry`, `toolCanBeRetriedAutomatically`.

**Duplicates.** Two retry philosophies: provider-level (`failover-provider`) and tool-level (`immune-system`). They operate at different boundaries and are correctly layered, but the boundary is undocumented. `PROJECT_STATUS.md` notes Caspa already converged on the Nexus recovery fabric — evidence the provider-level policy is the canonical one.

**Strongest implementation.** `failover-provider.ts` is the strongest artefact in the whole census: the transactional tool-call buffering rule and the no-failover-after-visible-text rule are exactly the correctness properties vNext needs. Port the semantics verbatim.

**Dependencies.** `ProviderError` taxonomy, performance ledger, cooldown callbacks injected from `router.ts`.

**Weaknesses.** Cooldown marking (`markRuntimeFailure`) is a callback injected by the router, so failover policy and router state are mutually dependent. Performance ledger is in-memory only (lost on restart, unshared across instances).

**Tests worth preserving.** `failover-provider.test.ts`, `streaming.test.ts`, `sse-heartbeat.test.ts`, `provider-http-diagnostics.test.ts`, `immune-system.test.ts`, `anthropic-transcript.test.ts`, `openai-responses.test.ts`, `openai-compatible-research-tool.test.ts`.

**Verdict: Port (failover semantics + error taxonomy) / Redesign (ledger persistence).** Failover adapter moves to the execution broker essentially unchanged; the performance ledger becomes a broker-owned durable store.

---

## 3. Provider health / discovery

**Where it lives.**

- `services/nexus/src/providers/provider-health.ts` (208 lines) — `checkProviderHealth`: concurrent probes per provider; status model distinguishes `healthy` (live proof) vs `configured` (credential present, probe inconclusive) vs `authentication_failure` vs `unavailable`. Ollama proven by `/api/show` + exact-token `/api/generate`; cloud providers by minimal real completions.
- `services/nexus/src/providers/ollama-discovery.ts` (71 lines) + `ollama-provider.ts` (182 lines) — local model enumeration.
- `services/nexus/src/provider-connections/routes.ts` — Vault-backed connection management incl. Forge/Hetzner negative-bias handling.
- Surface: `GET /api/providers`, `GET /api/models`, desktop `IntegrationStatusPanel.tsx` / `ModelSelector.tsx`.

**Duplicates.** Health probing (`provider-health.ts`) vs runtime cooldowns (`router.ts` cooldown map) vs performance ledger (`performance.ts`) are three views of "is this provider usable" with no single owner.

**Strongest implementation.** The four-state status model (`healthy/configured/auth-failure/unavailable`) is the keeper — it makes missing credentials *visible* instead of failing silently, a praised UX property.

**Dependencies.** Vendor endpoints, Vault (Forge keys), config.

**Weaknesses.** Probes issue real (if tiny) completions on every check — cost and rate-limit implications; no caching/TTL policy in code. Cooldowns and health disagree by design (cooldown is runtime, health is point-in-time) but nothing reconciles them for routing.

**Tests worth preserving.** `provider-health.test.ts`, `provider-health-status.test.ts`, `provider-connections.test.ts`, `ollama-discovery.test.ts`, `ollama-tools.test.ts`, `providers.test.ts`, `providers-cloud.test.ts`.

**Verdict: Redesign (single provider-registry owner).** Merge health + cooldown + performance-signal into one registry; keep the four-state model and the concurrent-probe structure. See `docs/NEXUS-CONTRACT.md`.

---

## 4. Vendor providers: OpenAI / Anthropic / Gemini / Venice / OpenRouter / xAI

**Where it lives.** `openai-provider.ts` (132), `openai-responses-provider.ts` (242), `anthropic-provider.ts` (199), `gemini-provider.ts` (158), `openrouter-provider.ts` (187), plus xAI/Grok via `src/xai/routes.ts` (Vault-stored key, `grok-4.6` default, `/v1/batches`) and `mock-provider.ts` (74, dev/test only, production-disabled via `mockFallbackRouteId`).

**Strongest implementation.** `openai-responses-provider.ts` (Responses API, the default OpenAI path) and `anthropic-provider.ts` are the most exercised; Venice/OpenRouter correctly reuse the OpenAI-compatible adapter (`openai-provider.ts` with base-URL override) rather than forking protocol code.

**Dependencies.** `provider-http.ts` streaming, `ProviderError` mapping per vendor, config keys, Vault (xAI).

**Weaknesses.** Vendor error→`ProviderError` mapping is per-adapter and untested in combination; model ids are env-configured strings with no validation (a stale `ANTHROPIC_MODEL` surfaces only at call time). xAI is route-shaped differently (Vault + bespoke routes, not a `ProviderAdapter`) — inconsistent with every other vendor.

**Tests worth preserving.** `gemini-tools.test.ts`, `openrouter-tools.test.ts`, all provider tests above, `provider-connections.test.ts`.

**Verdict: Port (adapter pattern + OpenAI-compatible reuse) / Merge (xAI into the adapter shape).** Every vendor, including xAI/Grok, becomes a broker-side adapter implementing one interface. Model-id validation moves to registry startup.

---

## 5. Ollama / local inference

**Where it lives.** `ollama-provider.ts`, `ollama-discovery.ts`, multi-model `OLLAMA_MODELS` support in `router.ts` (`ollama/local` + `ollama/<slug>` routes), `nexus/private` local-only capability with empty fallback chain.

**Strongest implementation.** The `localOnly` enforcement in `resolveCapability`/`capabilityCandidates` (filters `localProviders = {ollama, mock}`) is simple and correct — privacy by construction, not by prompt.

**Dependencies.** Local Ollama daemon (`OLLAMA_BASE_URL`, default `127.0.0.1:11434`).

**Weaknesses.** Health proof requires exact-token generation (brittle for small/quantized models that chatter). No context-window awareness per local model.

**Tests worth preserving.** `ollama-discovery.test.ts`, `ollama-tools.test.ts`, `venice-local-routing.test.ts` (local-routing edge cases).

**Verdict: Port.** Local-only routing constraint and discovery shape carry over unchanged.

---

## 6. RunPod (GPU / writing / music / compute)

**Where it lives.**

- `services/nexus/src/providers/runpod-writing-provider.ts` (97 lines) + `normalizeRunPodBaseUrl`; config `ATLAS_GPU_*` / `RUNPOD_*`.
- `services/nexus/src/compute/` — `governor.ts` (192), `runpod-workload-memory.ts` (145), `shared-gpu-profile.ts` (209), `shared-gpu-warm-routes.ts` (58), `worker.ts` (103), `catalogue.ts` (67), `compute_worker.py`.
- `scripts/runpod-*.mjs` (atlas-gpu, music, writing) + `deploy/runpod/` bootstrap (`bootstrap.sh`, `bootstrap-v4/v5.sh`, `broker-v5.py`).
- Tools: `tools/compute-fabric.ts`, `tools/compute-governor.ts`; skill `skills/compute-fabric/`.
- Docs: `docs/COMPUTE_FABRIC.md` — the key invariant: compute fabric is **shared Nexus infrastructure, not owned by any dungeon**.

**Duplicates.** RunPod appears as (a) a chat provider (`runpod` provider id in auto-failover), (b) a writing GPU, (c) a music engine, (d) a generic compute worker pool — four faces with separate config keys and health paths.

**Strongest implementation.** `compute/governor.ts` + `runpod-workload-memory.ts` (workload memory/failure tracking, migration `0028_runpod_workload_failures`) are the most durable thinking; `broker-v5.py` is the deploy-side counterpart.

**Dependencies.** RunPod API, Vault/connection routes, research/compute job stores.

**Weaknesses.** The `runpod` provider id is referenced in routing fallbacks but `configureProviders` never registers a generic `runpod` chat adapter — same stale-primary smell as `hetzner/chat`. GPU config key proliferation (`ATLAS_GPU_*` vs `RUNPOD_*` vs `ATLAS_MUSIC_GPU_*`).

**Tests worth preserving.** `compute-fabric.test.ts`, `compute-governor.test.ts`, `runpod-workload-memory.test.ts`, `runpod-writing-provider.test.ts`.

**Verdict: Merge + Redesign.** One broker-owned compute pool with workload classes (inference / writing-GPU / music / batch); per-dungeon RunPod clients are discarded. The "shared fabric, not dungeon-owned" invariant becomes a domain rule.

---

## 7. Forge / Hetzner inference (owned Power Pod)

**Where it lives.** References, not a dedicated adapter: `capability-router.ts` (`nexus/instant` primary `hetzner/chat`), `provider-connections/routes.ts` (Forge connection handling with negative-bias note), `hybrid-auto-policy.ts` (Power-Pod-first auto plan), `provider-health.ts` (no Hetzner probe — health flows through `atlasGpu*` RunPod-compatible check), `deploy/hetzner/` (~15 scripts), `services/nexus/src/compute/shared-gpu-*` (warm-pod routes).

**Strongest implementation.** The *policy* (owned capacity first when healthy, cloud fallback otherwise) in `hybrid-auto-policy.ts` + `autoPowerPodFailover` in `router.ts`.

**Dependencies.** Vault-stored Forge credentials, Hetzner host, warm-pod state.

**Weaknesses.** No first-class `hetzner`/`forge` adapter exists in `providers/` — the primary route of the default capability is unresolvable from `configureProviders` alone. Registration must happen out-of-band (and is therefore untestable in the unit suite except via `hetzner-auto-routing.test.ts` mocks). This is the single largest routing integrity gap.

**Tests worth preserving.** `hetzner-auto-routing.test.ts`, `dev-preview-canary.test.ts` (canary against owned capacity).

**Verdict: Redesign (make it real).** vNext registers the owned pod as an ordinary broker adapter with health + cooldown like any other provider; "owned first" becomes registry priority data, not special-case code paths.

---

## 8. Writing / Caspa

**Where it lives (local).** Writing Dungeon is the largest in-repo domain: `services/nexus/src/writing/` (15 files: `commission-store`, `commission-runner`, `commission-prompt`, `headless-worker`, `section-store`, `stylometry`, `claim-ledger`, `factuality-gate`, `evidence-library`, `research-policy`, `reader-journey`, `reader-state`, `production-specs`, `publication-lock`) + tools (`writing-commission`, `writing-sections`, `writing-bulk`, `writing-analysis`, `writing-style`, `writing-psychology`) + dungeon plugin (`dungeons/writing.ts`) + desktop `features/writing/` + skill `skills/writing-dungeon/`. Migrations `0013/0014`.

**Caspa (external).** The separate repository was audited read-only at
`55ea40911eee5e62d568f0e22f9c74fab1279229`. It contains the literary
intelligence plus checkpointed commission jobs, publication QA holds, result
checksums, and a Nexus recovery client. These confirm the direction already
described by Mountain: keep Caspa-specific craft while removing duplicated
infrastructure/routing. See `REPOSITORY-AUDIT.md` for direct source paths.

**Strongest implementation.** The durable ideas: commissions as long-running jobs (`commission-store` + `headless-worker`), claim ledger + factuality gate (every assertion traceable), evidence library, publication lock. These are provenance-before-prose — directly aligned with vNext's provenance requirement.

**Dependencies.** Provider routing (prose generation), research fabric (evidence), RunPod writing GPU, projects storage.

**Weaknesses.** Writing owns its own job/headless-worker machinery parallel to research jobs and investigation runs (three background-job shapes — see §17). Factuality machinery is excellent but deeply coupled to the writing schema.

**Tests worth preserving.** `writing-commission*.test.ts`, `writing-sections.test.ts`, `writing-bulk.test.ts`, `writing-evidence.test.ts`, `writing-stylometry.test.ts`, `writing-headless-worker.test.ts`, `claim-ledger.test.ts`, `publication-lock.test.ts`, `production-specs.test.ts`, `reader-journey-audit.test.ts`, `reader-state.test.ts`.

**Verdict: Port (provenance constructs) / Redesign (execution onto durable jobs).** Claim ledger, factuality gate, evidence library and publication lock become vNext project-level primitives; commission execution moves onto the single durable-job substrate. No Caspa code is copied; the interface direction is that Caspa later consumes vNext jobs/events like it consumes the recovery fabric today.

---

## 9. Website Studio (sites / dev-preview / portal)

**Where it lives.** Tools `website-studio.ts` (220) + `site-management.ts` (195); `src/dev-preview.ts` (310, Nexus-served preview with indexing), `src/site-lifecycle.ts` (328), `src/portal/` (`routes`, `client`, `runtime`), `src/artifact-download.ts`, `src/zip-extraction.ts`; desktop `features/portal/`; skill `skills/website-studio/`; `ops/website-studio/cleanup-dev-sites.sh`; docs `WEBSITE_STUDIO.md`, `product/DEV_PREVIEW_NEXUS_SERVING.md`; migrations for captures/portal (`0020`).

**Strongest implementation.** `dev-preview.ts` + `site-lifecycle.ts`: Nexus itself serves previews with lifecycle rules (recent fix "recover Website Studio from storage pressure" `5cc7a96` shows this is a live operational concern).

**Dependencies.** Artifact store (`0008_artifacts`), filesystem root, deployment scripts.

**Weaknesses.** Storage-pressure incident shows lifecycle/GC policy was reactive; preview indexing and artifact download are separate code paths for the same bytes.

**Tests worth preserving.** `website-studio.test.ts`, `website-artifact.test.ts`, `dev-preview*.test.ts`, `site-lifecycle.test.ts`, `artifact-download.test.ts`, `zip-extraction.test.ts`, portal tests.

**Verdict: Redesign (sites as content-addressed artifacts with lifecycle policy).** Preview serving becomes a thin read path over the vNext artifact store with explicit retention/GC — a storage-model concern, not a studio concern.

---

## 10. OSINT (engines, owned routing)

**Where it lives.** `tools/research-search.ts` (federated: brave/kagi/exa/searxng with RRF fusion, tracking-param stripping, query clamping), `tools/web-search.ts`, `tools/web-fetch.ts`, `tools/local-search.ts`, `research/bigbrother.ts`, `research/arcanum.ts`, `research/spiderfoot-engine.ts`, `research/public-target.ts` (target safety), `research/README.md`; deploy `ensure-searxng.sh`, `ensure-spiderfoot.sh`, `smoke-research-search.mjs`; skill `deep-research` + `fact-check`.

**Strongest implementation.** `research-search.ts` federation (multi-engine + RRF + `searxng` self-hosted fallback) is genuinely good infrastructure; `public-target.ts` target-gating is the safety property to keep.

**Dependencies.** Engine API keys (`BRAVE_*`, etc.), self-hosted searxng/SpiderFoot, permission gates.

**Weaknesses.** Engine fallback vs provider fallback are two unrelated mechanisms; OSINT tool results have evidential status only inside the research-runner path (`webFindings` marks `intelligence_lead`), not when tools are called ad hoc.

**Tests worth preserving.** `research-search.test.ts`, `web-search*.test.ts`, `web-fetch.test.ts`, `osint-owned-routing.test.ts`, `research-public-target.test.ts`, `research-fabric.test.ts`, `research-specialists.test.ts`, `research-unavailable.test.ts`.

**Verdict: Port (federation + target gating) / Redesign (uniform evidential envelope).** Every OSINT result carries provenance + evidential status regardless of call path.

---

## 11. Investigation (dungeon, runs, caseboard, portal)

**Where it lives.** The largest domain by file count: ~15 tool modules (`investigation*.ts`, caseboard, assurance, snapshots, sweeps, collaboration, publication, run-recovery, run-contract, engines, audit, local-sources), `investigation-run-executor.ts` (312), `investigation-portal/` routes + publication routes, `investigation-source-scheduler.ts`, dungeon plugin `dungeons/investigation.ts`, desktop `features/investigation/` + `features/dungeons/`, migrations `0017–0027` + `0031–0035` (workspace, audit, sources, captures, assurance, runs, snapshots, guest bundles, manual ingest, local sources), docs `integration/investigation-run-recovery-v2.md`.

**Duplicates.** Investigation runs vs research jobs vs writing headless jobs (see §17). Snapshots vs artifacts vs captures — three persistence shapes for "frozen state".

**Strongest implementation.** The run-contract + run-recovery pair (`investigation-run-contract.ts`, `investigation-run-recovery.ts`, `integration/investigation-run-recovery-v2.md`) is the most operationally mature durable-execution thinking in the repo; assurance/audit tooling is the provenance model to generalize.

**Dependencies.** OSINT engines, provider routing, scheduler, guest bundles/publication access control.

**Weaknesses.** Scope sprawl: 15 tool modules + 12 migrations for one dungeon suggests missing internal boundaries. Scheduler (`investigation-source-scheduler.ts`) is dungeon-owned background work that should be platform-owned.

**Tests worth preserving.** `investigation*.test.ts` (the full family — especially run-recovery, assurance, snapshots, collaboration, publication, local-sources), `dungeon-master.test.ts`, `dungeon-orchestration.test.ts`.

**Verdict: Redesign (dungeon as plugin over platform jobs/events).** Investigation becomes the reference plugin proving the dungeon contract; its scheduler, runs and snapshots migrate onto platform substrates. See `docs/DOMAIN-BOUNDARIES.md`.

---

## 12. Research (jobs, runner, specialists)

**Where it lives.** `research/job-store.ts` (127), `research/runner.ts` (54 + engines), `research/routes.ts` (112), tools `research-search`, `research-specialists`, `research-unavailable` (graceful degradation); migration `0030_research_jobs`; skill `deep-research`.

**Strongest implementation.** `ResearchRunner` (bounded concurrency, engine fan-out, finding correlation via bigbrother/arcanum) + `research-unavailable` fallback tools (degraded-mode as a first-class path, not an exception).

**Dependencies.** OSINT engines, conversations, permissions, SpiderFoot.

**Weaknesses.** Job store is SQLite-row polling (`ResearchJobStore`); no event emission on progress — clients poll. Runner concurrency cap is static config, not backpressure.

**Tests worth preserving.** `research-fabric.test.ts`, `research-specialists.test.ts`, `specialist-delegation-tools.test.ts`, `required-retrieval-loop.test.ts` (retrieval gating), `retrieval-intent.test.ts`.

**Verdict: Redesign onto durable jobs + events.** Research jobs are the prototype for the vNext job substrate (`docs/JOBS-AND-EVENTS.md`); runner logic ports, polling mechanics do not.

---

## 13. File / project storage (attachments, artifacts, ingest)

**Where it lives.** `attachments.ts`, `attachment-workspace.ts`, `attachment-validation.ts`, `ingest/direct-ingest.ts`, `tools/artifacts.ts`, `tools/execution-store.ts`, `projects.ts`, `context/project-context.ts`, `artifact-download.ts`, `zip-extraction.ts`; scripts `atlas-ingest-companion.mjs`, `atlas-ingest-worker.mjs`; migrations `0003/0004/0005/0008/0016/0029`; desktop `features/projects/`, `features/attachments/`.

**Strongest implementation.** Attachment provenance (`0016_attachment_provenance`, manifest-context) + processing-state machine (`0029`, `attachment-processing-state.test.ts`) — content lifecycle with explicit states is the right instinct.

**Dependencies.** `NEXUS_FILESYSTEM_ROOT` sandbox, `path-safety.ts`, project FK graph.

**Weaknesses.** Three content homes (attachments, artifacts, ingest workspace) with different provenance rules; binary extraction/OCR paths are format-specific code without a pipeline abstraction; the recent storage-pressure Website Studio fix shows no global quota/GC story.

**Tests worth preserving.** `attachments*.test.ts`, `attachment-*.test.ts` (manifest, OCR, binary extraction, backfill, workspace, upload-limit, processing-state), `artifacts.test.ts`, `filesystem-security.test.ts`, `project-context.test.ts`.

**Verdict: Redesign (content-addressed store with uniform provenance).** One store, one envelope; attachments/artifacts/ingest become views. See `docs/STORAGE-MODEL.md`.

---

## 14. Job execution & background work

**Where it lives.** Three parallel systems: (a) research jobs (`research/job-store.ts`, `runner.ts` with poll timer), (b) investigation runs (`investigation-run-executor.ts`, `tools/investigation-runs.ts`, scheduler), (c) writing headless jobs (`writing/headless-worker.ts`, `commission-runner.ts`, migration `0014`); plus `local-control/job-store.ts` (155) + `relay.ts` (617) for device-federated work; compute `worker.ts`.

**Duplicates.** This is the census's clearest merge target: three job stores, three polling loops, three recovery stories — one concept.

**Strongest implementation.** Investigation run-contract/recovery semantics (explicit contract + resumable recovery) grafted onto the research runner's engine fan-out; `commission-runner.ts` logging/observability habits.

**Dependencies.** Database, provider routing, tool registry, permissions.

**Weaknesses.** Polling everywhere; no durable event log; no idempotency keys; headless workers are per-domain rather than a pool; no cancellation propagation story (`AbortController` map in research runner is in-memory only).

**Tests worth preserving.** `writing-headless-worker.test.ts`, `investigation-runs.test.ts`, `investigation-run-recovery.test.ts`, `research-fabric.test.ts`, `local-control-bootstrap.test.ts`, `local-companion.test.ts`.

**Verdict: Merge + Redesign.** Single durable-job substrate with events, idempotency, cancellation and recovery — the centrepiece of `docs/JOBS-AND-EVENTS.md`.

---

## 15. Authentication (native auth, tenancy, mobile gateway)

**Where it lives.** `auth/native-auth.ts` (615) + `native-auth-gate.ts` (744) + `native-auth-main.ts`; `tenancy/` (`atlas-auth`, `context`, `database-router`, `background-tenants`, `owner-route-guard`); `mobile-gateway.ts` (separate authenticated gateway on 43102, pairing-token → HttpOnly cookie); `provider-connections/`; `breakglass` (`deploy/hetzner/BREAKGLASS_PUBLIC`); `native/atlas-os/` (Android foundation: app/core/voice/safety/vault/drive/policy/immune/location); desktop `features/auth/` (`AtlasLogin`, `NativePairingGate`); ops `google-sign-in.md`; `NEXUS_ACCESS_TOKEN` env.

**Strongest implementation.** The loopback-only Nexus + separate authenticated mobile gateway split is a genuinely good security shape; per-tenant database routing (`database-router.ts`) is the multi-tenancy seed; Atlas OS `policy/` + `safety/` (reversible lock/seal, network-independent safety actions) are correct device-side invariants.

**Dependencies.** SQLite tenant DBs, Vault key layer (hardware-backed on device), pairing tokens.

**Weaknesses.** Auth surface is large (native gate 744 lines + main 615 lines) with deploy-contract tests suggesting fragility (`native-auth-deploy-contract.test.ts`, `native-auth.test.ts`, `native-device-auth.test.ts`, `native-auth-gate.test.ts` — four test files for one boundary). Breakglass + forward-auth repair scripts (`repair-authentik-forward-auth.sh`, `DEPRECATED-OIDC-RECEIVER.md`) indicate auth evolution left debris.

**Tests worth preserving.** All native-auth tests, `breakglass-public-auth.test.ts`, `sso-tenancy.test.ts`, `mobile-access.test.ts`, `guest-usage.test.ts`, `permission-profile-api.test.ts`.

**Verdict: Port (gateway split, tenant routing) / Redesign (single capability-based session model).** vNext keeps loopback-core + authenticated-edge topology; collapses auth internals behind one session/capability boundary (see `docs/DOMAIN-BOUNDARIES.md`).

---

## 16. Permissions

**Where it lives.** `permissions/engine.ts` (235) + `store.ts` (105) + `profile-store.ts` (32); `agent/pending-permissions.ts` (91, agent-loop suspension on permission); `behaviour/` posture (store/resolver/prompt + migration `0027`); desktop `features/permissions/` (PermissionPanel, TrustProfilePanel, LocalControlPanel); tool-level guest denylists in `tools/registry.ts`; mode-policy tool filtering.

**Strongest implementation.** The agent-loop permission suspension (`pending-permissions.ts` + `AGENT_PERMISSION_TIMEOUT_MS`) — the loop *waits* for a human decision rather than failing or auto-allowing — is the safety property to preserve. Effective-policy computation (`effectivePolicy()` merging grants + profile) is sound.

**Dependencies.** Conversations (suspension scope), tool registry, tenant context (guest vs owner).

**Weaknesses.** Enforcement points are scattered (registry denylist, mode filter, engine, posture prompt) with no single choke point; posture/behaviour prompting mixes policy with persona.

**Tests worth preserving.** `permissions.test.ts`, `permission-profiles.test.ts`, `permission-profile-api.test.ts`, `behaviour-posture.test.ts`, `behaviour-routes.test.ts`, `agent-loop*.test.ts`, `mode-policy.test.ts`.

**Verdict: Redesign (capability-based, single choke point).** Permissions become capabilities checked at the broker boundary; the human-suspension semantic is preserved and generalized to all side-effecting calls.

---

## 17. Local / device control (companion, relay, Atlas OS)

**Where it lives.** `local-control/` (`relay.ts` 617, `job-store.ts`, `bootstrap.ts`); scripts `atlas-companion.mjs`, `atlas-device-relay.mjs`, `install-*-local-control.sh`, `install-*-from-atlas.sh`; desktop `mobile-local-control.ts`, `local-control-api.ts`, `features/mobile/`; `native/atlas-os/` (voice dual-wake, location, drive, immune); `tools/local-*` (filesystem, search); docs `local-companion.md`.

**Strongest implementation.** Relay + bootstrap (device pairing, capability advertisement) is the federation seed; Atlas OS module split (core stable boundary, safety independent of network) is the right device shape.

**Dependencies.** Mobile gateway auth, job store, MCP/browser tool injection.

**Weaknesses.** Companion scripts duplicate Nexus relay logic in JS (`atlas-companion.mjs` 41KB alongside `relay.ts`); install scripts per-OS multiply (`install-macos-*`, `install-android-*`); generated Capacitor shell vs Atlas OS native coexistence is unresolved upstream.

**Tests worth preserving.** `local-companion.test.ts`, `local-control-bootstrap.test.ts`, `mobile-access.test.ts`.

**Verdict: Merge (one relay protocol) / Port (Atlas OS module boundaries).** vNext defines one device-relay contract; companion scripts become thin clients of it.

---

## 18. Browser / tool execution (MCP, shell, python)

**Where it lives.** `tools/` — 60+ modules behind `registry.ts` (322): shell, python, local-filesystem (+ `path-safety.ts`), web-fetch/search, mcp-tools + mcp-discovery (Playwright MCP on 43103, browser navigation read-allowed by default), client-actions, skills tools, algorithm-library, deterministic/operational-analysis, portal/compute/governor/music/writing/investigation families; `agent/loop.ts` (447, the model/tool/permission loop); `tools/execution-store.ts`; `tools/json-schema.ts` validation; `check-*contract.mjs` scripts (browser-qa, compute-fabric, music-engine…).

**Strongest implementation.** The agent loop (`loop.ts`) with permission-gated tool execution + trace store is the behavioural core of Atlas; MCP discovery (inject advertised browser tools into the same loop) is the right extensibility shape; `path-safety.ts` + `NEXUS_FILESYSTEM_ROOT` sandboxing is the containment property.

**Dependencies.** Everything: providers, permissions, filesystem, MCP servers, Playwright runtime.

**Weaknesses.** 60+ tool modules registered in one file with no grouping/versioning — the plugin boundary (`dungeons/contract.ts`, 68 lines) exists but most tools bypass it. Contract-check scripts are shell+node hybrids, not runnable test gates in CI.

**Tests worth preserving.** `agent-loop.test.ts`, `agent-history.test.ts`, `agent-loop-idle-budget.test.ts`, `tool-contract.test.ts`, `mcp-tools.test.ts`, `mcp-discovery.test.ts`, `mcp-playwright.test.ts`, `shell-execution.test.ts`, `python-execution.test.ts`, `filesystem-security.test.ts`, `client-actions.test.ts`, `skills.test.ts`, `algorithm-library.test.ts`, `deterministic-analysis.test.ts`, `operational-analysis.test.ts`, `specialist-delegation-tools.test.ts`.

**Verdict: Redesign (plugin tools over a stable execution interface).** The loop's permission-gated semantics port; the 60-module registry is re-cut into versioned plugins behind the dungeon/tool contract. Contract scripts become real tests.

---

## 19. Deployment (Hetzner, RunPod, runners, no-Vercel policy)

**Where it lives.** `deploy/hetzner/` (15+ scripts: `atlas-mountain-deploy.sh`, `-v2.sh`, `bootstrap-ubuntu.sh`, Caddy/nginx configs, `start-nexus.sh`, `verify-nexus-runtime.sh`, canary `production-chat-canary.mjs`, pytest suite `tests/`), `deploy/runpod/` (music + shared bootstrap/broker), `ops/github-runner/`, `ops/local/Caddyfile`, `runtime-provider-policy.ts` (no-Vercel enforcement — banned host + env prefix + MCP URL check), `scripts/check-*.mjs` contract gates, `doctor.mjs`/`doctor-full.mjs`.

**Strongest implementation.** Transactional deploy scripts with pytest regression suites (`test_atlas_mountain_deploy.py`, `test_deploy_transaction_regressions.py`) + runtime canary + verify scripts: deployment as a *tested transaction* is the practice to keep.

**Dependencies.** Hetzner host, RunPod API, Caddy/nginx, GitHub runners.

**Weaknesses.** Two deploy scripts (`-v2.sh` alongside original) + repair scripts (`repair-*.sh`) signal incomplete migrations; the no-Vercel policy is string-matching (`ver${'cel.com'}` obfuscation to dodge self-scans) — effective but brittle and untestable in unit scope.

**Tests worth preserving.** Deploy pytest suite, `check-root-canonical-contract.mjs`, `check-host-local-deploy-contract.mjs`, `native-auth-deploy-contract.test.ts`, `dev-preview-canary.test.ts`.

**Verdict: Port (transactional + verified deploy practice) / Redesign (single transactional deployer).** vNext keeps canary + verify + rollback philosophy; collapses script sprawl into one deploy transaction with `docs`-level policy instead of string-match hacks.

---

## 20. Observability (logging, traces, performance)

**Where it lives.** `logger.ts` (pino, root redaction list for secrets/tokens), `agent/trace-store.ts` (per-conversation step ledger, `/api/conversations/:id/trace`), `providers/performance.ts` (TTFT/latency/failure ledger), `tools/provider-performance.ts`, commission-runner logging, Fastify request logs, `features/activity/` (ActivityPanel, IngestActivity).

**Strongest implementation.** Secret redaction at the logger root (inherited by all child/request loggers) is exactly right and must be a day-one vNext property. The trace-step ledger gives per-turn debuggability.

**Dependencies.** Pino, SQLite (`agent_steps`), in-memory perf ledger.

**Weaknesses.** Three disconnected telemetry paths (logs, traces, perf ledger) with no correlation id joining a user message → route decision → provider calls → tool executions. Perf ledger is volatile memory. No evaluation harness (routing heuristics unevaluated).

**Tests worth preserving.** `provider-performance.test.ts`, trace-adjacent `agent-history.test.ts`, `conversations.test.ts`.

**Verdict: Redesign (correlated, built-in observability).** One correlation id from message to tool result; durable perf ledger; redaction-by-default ports unchanged. Evaluation harness is new scope (vNext requirement).

---

## 21. Backup / recovery

**Where it lives.** `recovery/fabric.ts` (154) + `recovery/routes.ts` (33) — the shared recovery fabric Caspa already consumes; investigation run-recovery (§11); workload-failure memory (`0028`); deploy rollback/repair scripts; Vault key file (`.atlas-vault-key`, 0600) with no backup story visible.

**Strongest implementation.** The recovery *fabric* as shared infrastructure (not per-domain retries) is the concept to generalize — it already survived one cross-repo adoption.

**Dependencies.** Job stores, deploy scripts, database files.

**Weaknesses.** No documented backup/restore procedure for the SQLite databases or Vault master key — loss of `.atlas-vault-key` means total secret loss. Recovery fabric covers execution retry, not data recovery; the name overpromises.

**Tests worth preserving.** `recovery-fabric.test.ts`, `investigation-run-recovery.test.ts`, `database.test.ts`.

**Verdict: Redesign (backup/recovery as a domain, not a retry helper).** vNext splits *execution recovery* (broker retries) from *data backup/restore* (snapshots, key escrow, tested restore). Both are built-in requirements, not afterthoughts.

---

## 22. UI shell (desktop, mobile/PWA, dungeons UI)

**Where it lives.** `apps/desktop/` (Vite + TS: `App.tsx`, ~15 CSS skins, `features/` — chat, models, projects, investigation, writing, quantum, music, dungeons, permissions, portal, launch, behaviour, activity, attachments, mobile, tools, auth; `lib/` API clients; `state/` workspace context; PWA manifest + `sw.js`; Capacitor config + `copy-local-control-bootstrap.mjs`).

**Strongest implementation.** Feature-folder organization mirroring dungeon domains; workspace context provider; chat workbench (composer/list/controls/voice) is the most iterated UX; PWA + service worker gives installable mobile without native code.

**Dependencies.** Nexus HTTP/SSE API, mobile gateway, service worker.

**Weaknesses.** ~15 overlapping CSS skin files (`QuantumBrand`, `OcrowleyCommandSkin`, `CommandDeckPolish`…) suggest theming by accretion; `QuantumDungeonUltimate.tsx` alongside `QuantumDungeon.tsx` is an unmerged fork in the tree; dungeon UIs each reimplement panels/pulse/progress patterns.

**Tests worth preserving.** Desktop vitest suite (`MusicDungeon.test.tsx`, `QuantumDungeon.test.tsx`, `WritingDungeon.test.tsx`, `api.test.ts`, `speech.test.ts`, `web-share-target.test.ts`) — keep the *cases*, not the CSS.

**Verdict: Redesign (thin shell over dungeon plugin UI contracts).** vNext shell renders conversations/projects/permissions/activity once; dungeons contribute panels via a UI contract, not by forking the shell. Skins and `*Ultimate` forks are discarded.

---

## 23. Conversation handling (store, context, modes)

**Where it lives.** `conversations.ts` (187, CRUD + stale detection), `context/conversation-context.ts` + `project-context.ts` (retrieval assembly), `agent/mode-policy.ts`, `agent/retrieval-intent.ts` (35), `behaviour/posture-*` (persona/posture resolution), `POST /api/conversations/:id/messages` in `app.ts` (auto-routing, target normalization, streamed agent loop wiring), `streaming/` SSE; desktop chat features.

**Strongest implementation.** Project-scoped conversations (`project_id` FK, per-project context) + required-retrieval gating (`required-retrieval-loop.test.ts`) — conversations that *must* consult project state before answering.

**Dependencies.** Projects, providers, agent loop, tool registry.

**Weaknesses.** Target normalization (`auto`/`nexus/auto` aliases in `app.ts`) is ad-hoc string handling at the HTTP layer; posture/persona and retrieval policy interleave in prompt assembly with no precedence contract.

**Tests worth preserving.** `conversations.test.ts`, `conversation-context.test.ts`, `project-context.test.ts`, `required-retrieval-loop.test.ts`, `retrieval-intent.test.ts`, `mode-policy.test.ts`, `behaviour-*.test.ts`, `attachment-manifest-context.test.ts`, `client-actions.test.ts`.

**Verdict: Port (project-scoped conversations + retrieval gating) / Redesign (target resolution at Nexus boundary).** Message ingress normalizes targets once, against the registry — never string aliases in HTTP handlers.

---

## 24. Durable project state (projects, vault, tenancy stores)

**Where it lives.** `projects.ts` (CRUD + settings JSON), 35 migrations (the full domain schema: conversations, attachments, artifacts, permissions, vault, quantum, writing, investigation ×12, research, behaviour, workload failures, processing state), `tenancy/database-router.ts` (per-tenant DB files), `vault/store.ts` (134, AES-GCM secrets with fingerprint metadata, file-permission-hardened master key), `behaviour/posture-store.ts`, `quantum/run-store.ts`, `writing/*-store.ts`, `research/job-store.ts`.

**Strongest implementation.** The migration chain itself (35 ordered, single-writer SQLite via better-sqlite3) is disciplined schema evolution worth emulating; Vault's encrypted-at-rest secret store with fingerprints (no plaintext in DB) is the credential pattern to keep.

**Dependencies.** better-sqlite3, filesystem, tenant router.

**Weaknesses.** Domain stores each invent their own record shape/CRUD (no shared durable-state idiom); settings JSON blobs (`settings_json`) hide queryable state; per-tenant DB files + single SQLite file mean no story for concurrent writers or point-in-time backup.

**Tests worth preserving.** `database.test.ts`, `sso-tenancy.test.ts`, project/permission/quantum-run store tests, `vault`-adjacent provider-connection tests.

**Verdict: Port (migration discipline + Vault pattern) / Redesign (uniform durable-state idiom).** vNext keeps ordered migrations and encrypted Vault semantics; replaces bespoke stores with one durable-project model (see `docs/STORAGE-MODEL.md`).

---

## 25. Cross-cutting: quantum, music, xAI-batch, skills, behaviour

- **Quantum** (`quantum/`, 2.6k lines: simulator, compiler, GTG, IBM client, run-store, briefing, unlock + `qiskit_compile.py`): the most self-contained domain — simulator + compiler + run provenance (`0012_quantum_compiled_provenance`). Verdict: **Port as a plugin**; it already looks like one. Tests: `quantum-*.test.ts`.
- **Music** (`tools/music-*.ts` ×4, RunPod music scripts, install-music-runtime, `skills/music-dungeon/`, desktop `features/music/`): engine + native (ACE-step) + production pipeline split is sensible; deploy coupling (install scripts) is not. Verdict: **Merge** engine paths behind one music plugin; **discard** install-script sprawl in favour of the transactional deployer. Tests: `music-*.test.ts`.
- **xAI batch** (`xai/routes.ts`): batch endpoint via Vault key. Verdict: **Merge** into vendor-adapter shape (§4).
- **Skills** (`skills/*/SKILL.md` + `skill.json`, `tools/skills.ts`): markdown-delivered specialist prompting (compute-fabric, deep-research, fact-check, debugging, capability-acquisition, dungeon skills). Verdict: **Port** the skill *format* (versioned markdown + JSON manifest) as the vNext plugin-contributed prompt pack mechanism; **redesign** distribution (registry, not scattered folders).
- **Behaviour/posture** (`behaviour/`, `agent/mode-policy.ts`): persona + posture resolution. Verdict: **Merge** into conversation policy; persona prompting must not live beside permission enforcement (§16).

---

## Global findings

1. **One Nexus, too many jobs.** Three background-job systems, three content stores, three telemetry paths, two deploy scripts, two companion implementations. Every duplication is a merge target for the vNext substrates (jobs/events, storage, observability, deploy).
2. **Routing integrity gap.** The default capability (`nexus/instant`) and the owned-capacity story both point at route ids (`hetzner/chat`, `runpod`) with no registered adapter in `configureProviders`. vNext's registry must refuse to boot a capability whose chain is unresolvable — fail loud at startup, not silent at runtime.
3. **Correctness properties worth preserving verbatim.** Transactional tool-call buffering with no-failover-after-visible-text (§2); local-only enforcement (§5); permission-suspension loop (§16); logger-root secret redaction (§20); project-scoped retrieval gating (§23); Vault encrypted-at-rest secrets (§24).
4. **Test corpus is the real treasure.** ~130 Nexus test files + desktop suite + deploy pytest. The vNext migration rule: port the *cases* (especially failover, routing, recovery, permission, provenance and contract tests), not the code.
5. **Boundaries to preserve, cosmetics to discard.** Preserve: capability routing semantics, recovery fabric, provenance constructs (claim ledger, assurance/audit, attachment provenance), gateway topology, dungeon plugin contract, skill format. Discard: CSS skins, `*Ultimate` forks, repair scripts, string-match policies, per-domain job stores, companion script duplication.
