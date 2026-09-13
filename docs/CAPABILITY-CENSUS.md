# Capability census

Atlas Mountain is a behavioural reference, not an architectural template. This census records **where behaviour currently lives**, which copy is strongest, and whether vNext should **port**, **redesign**, **merge**, or **discard** it.

Inspected on 2026-09-13 from:

| Repository | Access | Role in census |
|---|---|---|
| `ocrowleymatt-stack/atlas-mountain` (`/agent/repos/atlas-mountain`, `main` @ `5cc7a96`) | Yes | Primary behavioural reference |
| `ocrowleymatt-stack/flipper-marauder-ai` (this repo) | Yes | **Destination** Atlas vNext greenfield |
| `ocrowleymatt-stack/Caspa` | Yes | Writing/commission predecessor |
| `ocrowleymatt-stack/ocrowley-commons` | Yes | OSINT toolkit, WHO jobs, policy, quality gates |
| `ocrowleymatt-stack/Shakespeare-` | Yes | Earlier writing UI (Firebase) |
| `ocrowleymatt-stack/TheBigBrother` | Yes | OSINT engine (fork) |
| `ocrowleymatt-stack/Life-os` | Yes | Python multi-agent orchestrator (not Atlas) |
| `ocrowleymatt-stack/craigs-navigator` | Yes | Companion/overnight monitor (not Atlas core) |
| `ocrowleymatt-stack/atlas` | **Inaccessible** | GraphQL: repository does not exist for this principal |
| `ocrowleymatt-stack/Nexus` | **Inaccessible** | Not found |
| `ocrowleymatt-stack/nexus-backend` | **Inaccessible** | Not found |
| `ocrowleymatt-stack/nexus-dashboard` | **Inaccessible** | Not found |
| `ocrowleymatt-stack/spiderfoot-ui` | **Inaccessible** | Not found (referenced by `@ocrowley/osint` as an external shell) |
| `ocrowleymatt-stack/Life` | **Inaccessible** | Not found; `Life-os` is the public stand-in |

Nexus as a *named product* currently lives **inside** `atlas-mountain/services/nexus`, not in a standalone org repo.

Stack fact used for vNext: atlas-mountain is TypeScript/Node 22, npm workspaces, React/Vite UI, Fastify Nexus, SQLite, Zod, Vitest (`atlas-mountain/docs/decisions/0001-monorepo-stack.md`). Caspa is Express + Firebase. Commons OSINT is a TS package plus Python bridges. **vNext keeps TypeScript/Node** because the strongest routing, failover, jobs and contract tests are already in that stack.

---

## Cross-cutting finding: Nexus is overloaded

`atlas-mountain/docs/decisions/0002-atlas-nexus-boundary.md` says Atlas owns UI and Nexus owns routing, adapters, persistence, execution, health and logging. In the running tree Nexus also owns Writing, Investigation, Research, Website Studio, Music, Quantum, local control, tenancy, auth, recovery, vault, compute fabric and dungeon manifests.

That coupling is the primary architectural defect to **not** copy. Behaviour in those modules is valuable; their residence inside Nexus is not.

---

## 1. Model / provider routing

**Where it lives**

- Capability aliases + fallback chains: `atlas-mountain/services/nexus/src/providers/capability-router.ts`
- Runtime resolve + adapter registration: `atlas-mountain/services/nexus/src/providers/router.ts`
- Prompt auto-route (regex scoring): `atlas-mountain/services/nexus/src/providers/auto-router.ts`
- Hybrid auto (Power Pod / research): `atlas-mountain/services/nexus/src/providers/hybrid-auto-policy.ts`
- Compute-class governor (orthogonal, cheaper-compute first): `atlas-mountain/services/nexus/src/compute/governor.ts`
- Shared contracts: `atlas-mountain/packages/shared/src/index.ts` (`capabilityAliasSchema`, `RouteConfig`, `RouteResolution`)
- Caspa intent router (writing-only): `Caspa/src/services/intent-router.ts`

**Duplicates:** capability-router (declarative chains) vs auto-router (prompt scoring) vs hybrid-auto-policy (RunPod-first) vs compute governor (task class). Caspa has a separate writing intent router. All four solve “where should this go?” with different inputs.

**Strongest:** `capability-router.ts` + `packages/shared` route types. Chains are inspectable, testable, and already distinguish capability vs explicit targets. Auto-router is a useful *application* heuristic, not a Nexus primitive.

**Dependencies:** `@atlas/shared`, env keys in `services/nexus/src/config.ts`, vault-backed Hetzner restore in `provider-connections/routes.ts`.

**Weaknesses**

- Aliases hardcode provider *route ids* (`hetzner/chat`, `anthropic/claude`), not capabilities. Adding a model requires editing routing logic.
- `hetzner/chat` is a primary on `nexus/instant` even when Hetzner is unconfigured; resolution then walks fallbacks.
- Failover is wrapped *inside* `resolveRoute()` (`FailoverProviderAdapter`). Nexus decides *and* executes.
- No cost-class or context-window fields on models; ranking is static list order plus a performance overlay (`providers/performance.ts`).
- Aliases mix product modes (`nexus/deep`, `nexus/adversarial`, `nexus/experimental`) with routing capabilities.

**Tests worth preserving (behaviour, not files)**

- `services/nexus/src/tests/capability-routing.test.ts` — primary, fallback, skip unavailable, local-only.
- `services/nexus/src/tests/auto-router.test.ts`, `hetzner-auto-routing.test.ts`, `osint-owned-routing.test.ts`.

**vNext:** **Redesign.** Declarative provider/model registry + alias policies. Applications request `nexus/fast`, `nexus/reason`, `nexus/code`, `nexus/vision`, `nexus/cheap`, `nexus/local`, `nexus/frontier`. Prompt auto-route belongs in the conversation app, not Nexus.

---

## 2. Retries / failover / streaming

**Where it lives**

- Policy: `atlas-mountain/docs/runtime-provider-resilience.md`
- Implementation: `services/nexus/src/providers/failover-provider.ts`
- Error taxonomy: `services/nexus/src/providers/provider-error.ts`
- Streaming events: `packages/shared/src/index.ts` (`StreamEvent`)
- Agent loop: `services/nexus/src/agent/loop.ts`

**Duplicates:** Caspa `jobQueueService` retries commissions independently. Research/writing/local-control each have their own job retry fields. Recovery fabric (`services/nexus/src/recovery/`) is a third retry philosophy.

**Strongest:** `failover-provider.ts` + the resilience doc. Proven rules:

1. Retry `timeout` / `unavailable` / pre-output `abrupt_end` once on the same provider.
2. Non-retryable (`auth_failure`, `invalid_request`, `context_length`, 4xx) skip to next candidate.
3. **Once any assistant text is emitted, never switch providers** (no double answer).
4. Buffer tool-call chunks until the stream commits; discard on pre-text death.

**Weaknesses:** This logic is a provider adapter *inside Nexus routing*. Circuit breakers are a 120s cooldown map on the router (`providerCooldownMs`), not a broker.

**Tests:** `services/nexus/src/tests/failover-provider.test.ts` — fall-through, no retry after visible text, tool-call buffering, transient retry.

**vNext:** **Port the rules, move the code** into `platform/execution`. Nexus returns an ordered candidate list only.

---

## 3. Provider health / discovery

**Where it lives**

- Live probes: `services/nexus/src/providers/provider-health.ts`
- Ollama model discovery: `services/nexus/src/providers/ollama-discovery.ts`
- Cooldown: `markProviderUnavailable` in `router.ts`
- UI: `apps/desktop/src/features/models/IntegrationStatusPanel.tsx`

**Duplicates:** health probe vs cooldown vs `runpod_workload_failures` (`migrations/0028_runpod_workload_failures.sql`, `compute/runpod-workload-memory.ts`). Three “this provider is bad” stores.

**Strongest:** `provider-health.ts` status model: `healthy` | `configured` | `authentication_failure` | `unavailable`. Distinguishes missing config from live failure. Concurrent probes.

**Weaknesses:** Health is not a first-class registry field. Instant route still *lists* unhealthy primaries. Ollama is always probed even with no daemon.

**Tests:** `services/nexus/tests/startup.test.ts` (qualification after listen). Capability routing tests for cooldown skip.

**vNext:** **Redesign.** Registry `health` is an input to routing. Probes live in execution/ops, write health into the registry. Discovery is a registry updater, not a router side effect.

---

## 4. OpenAI

**Where it lives**

- Responses API adapter: `services/nexus/src/providers/openai-responses-provider.ts` (production path in `configureProviders`)
- Chat Completions adapter (reused for Venice/Hetzner): `services/nexus/src/providers/openai-provider.ts`
- Health: `checkOpenAIHealth` in `provider-health.ts`
- Caspa: `Caspa/src/routes/ollama-routes.ts` and Gemini/OpenAI client code under `Caspa/src/services/`

**Duplicates:** two OpenAI protocol adapters in Nexus; Caspa has its own clients.

**Strongest:** `openai-responses-provider.ts` for OpenAI-the-vendor; `openai-provider.ts` as the OpenAI-*compatible* transport (Venice, Hetzner, OpenRouter).

**Weaknesses:** Protocol quirks mixed into Nexus. Model id defaults (`gpt-5.6-terra` in `config.ts`) are env-era artifacts.

**Tests:** tool/transcript tests around OpenAI-compatible research tools (`openai-compatible-research-tool.test.ts`).

**vNext:** **Redesign as an execution adapter.** Keep Responses vs compatible as two adapters behind one interface. Do not port default model ids.

---

## 5. Anthropic

**Where:** `services/nexus/src/providers/anthropic-provider.ts`, health in `provider-health.ts`, transcript test `tests/anthropic-transcript.test.ts`.

**Duplicates:** none of equal quality.

**Strongest:** Nexus Anthropic adapter. Default reason/frontier primary in current chains.

**Weaknesses:** Tool/transcript mapping is adapter-specific (belongs in execution). Hardcoded as `anthropic/claude` route id.

**vNext:** **Port behaviour into an execution adapter**; register models in config.

---

## 6. Gemini

**Where:** `services/nexus/src/providers/gemini-provider.ts`, `tests/gemini-tools.test.ts`. Vision alias primary.

**Strongest:** Nexus Gemini adapter + tool tests.

**Weaknesses:** Same as other vendors — protocol in the router process.

**vNext:** **Port as execution adapter.** Vision capability is a registry flag, not “Gemini is the vision route”.

---

## 7. Venice

**Where:** Instantiated as `OpenAIProviderAdapter(..., 'https://api.venice.ai/api/v1', ..., 'venice')` in `router.ts`. No dedicated adapter file.

**Duplicates:** none.

**Strongest:** OpenAI-compatible reuse. Correct instinct.

**Weaknesses:** Easy to confuse with a first-class protocol. Defaults (`deepseek-v4-flash`) belong in registry config.

**vNext:** **Merge** into the OpenAI-compatible adapter with a Venice provider record.

---

## 8. Ollama / local inference

**Where:** `ollama-provider.ts`, `ollama-discovery.ts`, `nexus/private` local-only chain, `localProviders = {ollama, mock}`.

**Duplicates:** Caspa `src/routes/ollama-routes.ts`.

**Strongest:** Nexus Ollama adapter + private-route local-only enforcement in `capability-router.ts`.

**Weaknesses:** Multiple models registered via comma-separated `OLLAMA_MODELS`; first model is `ollama/local`, others are slugs. Mock treated as “local”.

**Tests:** capability-routing local-only cases; health probe for exact token `ATLAS_LOCAL_OK`.

**vNext:** **Port local-only policy.** Discovery updates registry. Mock is a test adapter, not a local provider.

---

## 9. RunPod

**Where**

- Writing GPU adapter: `providers/runpod-writing-provider.ts`
- Workload failure memory: `compute/runpod-workload-memory.ts`
- Shared GPU profile / warm routes: `compute/shared-gpu-profile.ts`, `shared-gpu-warm-routes.ts`
- Deploy: `atlas-mountain/deploy/runpod/`, `scripts/runpod-*.mjs`
- Music ACE-Step: `deploy/runpod/music/`

**Duplicates:** writing GPU vs music renderer vs “atlas GPU” health probe (`atlasGpuBaseUrl` in health). Three RunPod personalities.

**Strongest:** `runpod-writing-provider.ts` + durable commission targeting `runpod/writing`. Failure memory is an operational lesson: do not keep sending work to a pod that just died.

**Weaknesses:** Route ids (`runpod/writing`) encode dungeon intent. Auto-router prefers Power Pod for bulk work, which pulled OSINT into GPU inference until `osint-owned-routing.test.ts` patched it. That patch is a symptom of mixing domain routing with model routing.

**vNext:** **Redesign.** RunPod is a *runtime* (`runtimes/runpod`) registering GPU models. Dungeons request `nexus/cheap` or a GPU capability, they do not own the pod. Preserve failure-memory as execution/health policy.

---

## 10. Forge / Hetzner inference

**Where**

- OpenAI-compatible adapter registered as `hetzner`, base `https://inference.hetzner.com/api/v1`: `provider-connections/routes.ts`
- Vault secrets `provider.hetzner.api_key` / `provider.hetzner.model`
- Host deploy: `atlas-mountain/deploy/hetzner/` (Nexus *hosting*, distinct from inference)
- Caspa leftover OIDC receiver: `Caspa/deployment/atlas-mountain-oidc/` (deprecated; see `deploy/hetzner/DEPRECATED-OIDC-RECEIVER.md`)

**Duplicates:** Caspa still contains Atlas Mountain deploy receivers. Atlas Mountain has v1 and v2 deploy scripts plus authenticated installer.

**Strongest:** Vault-backed Hetzner inference connection + OpenAI-compatible adapter. Hosting scripts are operationally mature but historically gnarly (root canonical cutover docs).

**Weaknesses:** Instant route assumes Forge is the fast primary. Hosting and inference are conflated in operator mental model.

**vNext:** **Split.** `runtimes/hetzner` = always-on Nexus/host/storage. Hetzner Inference is one cloud provider in the registry. **Discard** Caspa OIDC receiver path.

---

## 11. Writing / Caspa

**Where**

- Current Atlas dungeon (logic inside Nexus): `services/nexus/src/writing/` (`commission-store.ts`, `commission-runner.ts`, `headless-worker.ts`, claim ledger, stylometry, reader-journey, publication-lock)
- Tools: `services/nexus/src/tools/writing-*.ts`
- UI: `apps/desktop/src/features/writing/`
- Skill: `skills/writing-dungeon/SKILL.md` (durable commission rules — high signal)
- Caspa: full Express app, `src/routes/caspa-job-routes.ts`, `caspa-write-routes.ts`, `jobQueueService`, quality/gold/psychology
- Shakespeare-: Firebase writing UI, not current
- Commons quality: `ocrowley-commons/packages/quality/` (AI smell, polish, human-voice)

**Duplicates:** Caspa job queue vs Atlas `writing_commissions` vs Shakespeare localStore. Two commission runners in Atlas (`commission-runner` vs `headless-worker`) with overlapping phases.

**Strongest behavioural sources**

1. Atlas `commission-store.ts` — durable job: status, phase, progress, checkpoint, lease, heartbeat, attempt/no-progress counts.
2. `skills/writing-dungeon/SKILL.md` — “closing the browser does not cancel the job”.
3. Caspa `CASPA_REWIRE_NOTES.md` — artefact-first output, plan vs write vs cut routing, research honesty (`web_search_unavailable`).
4. Commons `@ocrowley/quality` — deterministic anti-slop gates.

**Weaknesses:** Domain logic inside Nexus. Dual runners. Caspa still on Firebase/Express. Shakespeare is legacy UI.

**Tests:** `writing-commission-routes.test.ts`, `claim-ledger.test.ts`, desktop `WritingDungeon.test.tsx`. Caspa has fewer automated contract tests.

**vNext:** **Do not port domain logic in this phase.** Stub `dungeons/writing`. Later: **merge** Atlas durable-commission behaviour + Caspa artefact-first router + commons quality gates into the Writing dungeon. **Discard** Shakespeare as a product; salvage UX ideas only.

---

## 12. Website Studio

**Where:** `docs/WEBSITE_STUDIO.md`, `tools/website-studio.ts`, `tools/site-management.ts`, `skills/website-studio/SKILL.md`, `ops/website-studio/`, Playwright MCP tests `tests/mcp-playwright.test.ts`, deploy browser QA `deploy/hetzner/install-playwright-runtime.sh`.

**Duplicates:** none of equal depth.

**Strongest:** documented pipeline `brief → art direction → implementation → build/test → deterministic audit → rendered browser QA → critique → verify`. `web.project.audit` + Playwright MCP. Site lifecycle (dev expiry vs production-protected) in PROJECT_STATUS.

**Weaknesses:** Lives in Nexus tools. “production” means “do not auto-expire”, not “public ingress is healthy”. No objective benchmark suite yet (called out in PROJECT_STATUS).

**vNext:** **Redesign into `dungeons/website`.** Preserve QA/audit behaviour and transactional deploy rules. Stub only this phase.

---

## 13. OSINT

**Where**

- Commons (strongest toolkit): `ocrowley-commons/packages/osint/` — `who()`, full toolkit, WHO jobs + **SSE** (`GET /api/who/jobs/:id/events`), dossiers, hash-chained audit, bridges to SpiderFoot / BigBrother / SpiderDash
- Atlas research engines: `services/nexus/src/research/`, `tools/research-search.ts`, `tools/research-specialists.ts`
- TheBigBrother: `TheBigBrother/the_big_brother/modules/` (username enum, dorks, EXIF, crypto, etc.) — consumed via bridge, not vendored
- Caspa: `Caspa/src/routes/osint-routes.ts` (thin)
- Atlas OSINT routing patch: `tests/osint-owned-routing.test.ts`

**Duplicates:** Atlas research fabric vs `@ocrowley/osint` vs Caspa OSINT routes vs BigBrother GUI. Spiderfoot-ui is **missing** (inaccessible); commons treats it as an attached shell.

**Strongest:** `@ocrowley/osint` jobs (`whoJobService.ts`, `whoProgress.ts`) with SSE, retry, cancel, case-scoped auth. Atlas investigation/research adds evidence-grade persistence the commons package does not.

**Weaknesses:** Default-deny case header is good; Atlas then reimplemented research jobs without that contract. Weaponized BigBrother description is a policy risk — dungeon must stay behind `network.public` + explicit scopes.

**Tests:** `packages/osint/test/whoJobs.test.ts`, `whoAuth.test.ts`, `toolkit.test.ts`, Python `test_osint_registry.py`, `test_bigbrother_registry.py`. Atlas `research-fabric.test.ts`, `osint-owned-routing.test.ts`.

**vNext:** **Merge later** into `dungeons/osint`: commons WHO orchestration + Atlas durable project/evidence + BigBrother as a runtime adapter. **Not in this phase.** Nexus must not learn OSINT.

---

## 14. Investigation

**Where:** `services/nexus/src/dungeons/investigation.ts` (manifest only), `tools/investigation*.ts`, `investigation-run-executor.ts`, `investigation-portal/`, migrations `0017`–`0035`, UI `apps/desktop/src/features/investigation/`, docs `docs/integration/investigation-run-recovery-v2.md`.

**Duplicates:** Investigation runs vs research jobs vs writing commissions — three durable-job shapes.

**Strongest:** Evidence captures with SHA-256, snapshots with reproducible manifests (`investigation-snapshots.test.ts`), run recovery, source sweeps, guest bundles, publication access, local sources. This is the best *evidence/provenance* implementation in the org.

**Weaknesses:** Entirely inside Nexus. Tool explosion (`investigation-*.ts`).

**Tests:** large suite — `investigation.test.ts`, `investigation-runs.test.ts`, `investigation-run-recovery.test.ts`, `investigation-snapshots.test.ts`, `investigation-sources.test.ts`, `investigation-publication*.test.ts`, collaboration/assurance/engines.

**vNext:** **Redesign into `dungeons/investigation`.** Preserve evidence hash/manifest and run-recovery *behaviours* as the template for durable jobs + provenance. Do not copy the tool surface into Nexus.

---

## 15. Research

**Where:** `services/nexus/src/research/job-store.ts`, `research/routes.ts`, `migrations/0030_research_jobs.sql`, `skills/deep-research/SKILL.md`, `skills/fact-check/SKILL.md`. Commons `packages/research/` (claims tests).

**Duplicates:** ResearchJobStore vs Investigation runs vs `@ocrowley/osint` WHO jobs vs Caspa research routes.

**Strongest hybrid:** Atlas `ResearchJobStore` (queued/running/completed/cancelled/failed, phase, progress, engines, findings) + commons research *claims* package. SSE exists on WHO jobs, not consistently on Atlas research jobs (Atlas chat uses SSE; research jobs are more store-centric).

**Weaknesses:** Engine list hardcoded (`web | spiderfoot | bigbrother | arcanum`). SpiderFoot UI repo missing.

**Tests:** `research-fabric.test.ts`, `research-search.test.ts`, `research-specialists.test.ts`, `research-unavailable.test.ts`. Caspa honesty about unavailable search is a product rule to keep.

**vNext:** **Merge** into `dungeons/research` using the **platform job/event** model. Preserve “do not pretend research happened”.

---

## 16. File / project storage

**Where**

- Projects table: `migrations/0004_projects.sql` — `id, name, archived, settings_json`. Conversations *reference* projects (nullable FK).
- Artifacts: `migrations/0008_artifacts.sql` — path-unique files, not content-addressed.
- Attachments: `attachments.ts` — SHA-256 stored, but blobs live as `content_base64` in SQLite plus tenant workspace materialisation (`attachment-workspace.ts`).
- Investigation captures: content SHA-256 + version_ref `sha256:...`
- Caspa: `caspa-storage-routes.ts`, Firebase/Drive (`Shakespeare-/src/lib/googleDrive.ts`)
- Vault: `services/nexus/src/vault/store.ts`

**Duplicates:** SQLite blobs vs workspace files vs Drive vs Firebase. Dedup is incomplete (hash stored, payload still duplicated).

**Strongest lessons:** project entity exists and is not the conversation; investigation snapshots prove content-addressed manifests work; ZIP bomb/path-safety in `zip-extraction.ts` / `tools/path-safety.ts`.

**Weaknesses:** Revisions are not manifests over blobs. Conversation is still the gravitational centre (`conversations` is migration 0001; projects arrive in 0004). Artifact uniqueness is `relative_path`, so “new revision” tends to mean “new path”.

**Tests:** `attachments.test.ts`, `attachment-workspace.test.ts`, `attachment-processing-state.test.ts`, `artifacts.test.ts`, `filesystem-security.test.ts`.

**vNext:** **Redesign.** Content-addressed blob store + manifests. Projects are authoritative. See `docs/STORAGE-MODEL.md`.

---

## 17. Job execution

**Where (four implementations)**

| Job family | Path | SSE? | Lease/resume? |
|---|---|---|---|
| Writing commissions | `writing/commission-store.ts` | UI polls progress | Yes (lease, heartbeat, reclaim) |
| Research jobs | `research/job-store.ts` | Partial | Status/phase, no lease |
| Investigation runs | `tools/investigation-runs.ts` + executor | No (HTTP) | Recovery v2 |
| Local-control jobs | `local-control/job-store.ts` | No | Device-scoped counters |
| Caspa jobs | `Caspa/src/services/jobQueueService` | No | User-scoped |
| WHO jobs | `ocrowley-commons/packages/osint/src/jobs/` | **Yes** | retry/cancel |

**Strongest:** Writing commission lease/checkpoint + WHO SSE. Together they almost match the vNext job contract; neither is complete.

**vNext:** **Redesign one platform job type** (`platform/jobs`). Dungeons attach domain payloads. **Discard** per-dungeon stores as sources of truth.

---

## 18. Background work

**Where:** `writing/headless-worker.ts`, `investigation-run-executor.ts`, `investigation-source-scheduler.ts`, `compute/worker.ts` + `compute_worker.py`, Caspa `runServerCommission`, commons `whoWorker.ts`.

**Duplicates:** each domain starts its own worker.

**Strongest:** writing headless worker (survives browser close) and compute worker isolation (no secrets, no network, no shell — `docs/COMPUTE_FABRIC.md`).

**vNext:** **Redesign** as `platform/execution` workers + job runners. Compute fabric becomes a *runtime*, not Nexus domain logic.

---

## 19. Authentication

**Where**

- Native/device: `services/nexus/src/auth/native-auth.ts`, `native-auth-gate.ts`, `migrations/0015_native_auth.sql`
- Tenancy/SSO: `tenancy/atlas-auth.ts`, `tenancy/owner-route-guard.ts`, `docs/operations/google-sign-in.md`
- Caspa: Firebase auth
- Commons WHO: case PIN / bearer (`whoAuth.test.ts`)
- Break-glass: `tests/breakglass-public-auth.test.ts`

**Duplicates:** Firebase vs native device pairing vs planned `sso.ocrowley.com` OIDC. PROJECT_STATUS: SSO must not be enabled until owner subject is pinned.

**Strongest:** native-auth + owner/guest SQLite split (`tenancy/database-router.ts`). Guest aggregate usage without prompt bodies is a privacy lesson to keep.

**vNext:** **Redesign** in `platform/auth`. Port native pairing and owner/guest isolation. Do not port Firebase. Do not copy break-glass without an explicit flag.

---

## 20. Permissions

**Where:** `packages/shared/src/index.ts` (`permissionCapabilitySchema`, `defaultPermissionPolicy`), `migrations/0006_permission_grants.sql`, `0009_permission_profile.sql`, `agent/pending-permissions.ts`, UI `PermissionPanel.tsx`, `TrustProfilePanel.tsx`.

Current default capabilities: `filesystem.read|write|delete`, `shell.execute`, `browser.navigate|submit`, `system.admin`, `mcp.invoke`. Tool metadata still uses coarse `scope: filesystem|network|execution|external`.

**Duplicates:** tool `requiresUserConsent` vs capability policy vs grants vs trust profile.

**Strongest:** dotted capability strings, ALLOW/ASK/DENY, session/project/global grants, unknown → ASK.

**Weaknesses:** Incomplete vs vNext scopes (`network.public|private`, `browser.control`, `repo.read|write`, `deployment.promote`, `secrets.use`, `device.control`). Logic scattered across tools.

**Tests:** `permission-profiles.test.ts`, `permission-profile-api.test.ts`.

**vNext:** **Redesign** in `platform/permissions` with the explicit vNext scope list. Tools declare scopes; they do not evaluate them.

---

## 21. Local / device control

**Where:** `services/nexus/src/local-control/`, `docs/local-companion.md`, `scripts/atlas-companion.mjs`, `atlas-device-relay.mjs`, install scripts for macOS/Android, UI `LocalControlPanel.tsx`, mobile `apps/desktop/src/lib/mobile-local-control.ts`, `native/atlas-os/`.

**Duplicates:** companion scripts vs native atlas-os vs mobile gateway (`services/nexus` mobile-gateway).

**Strongest:** device jobs with progress counters; companion as a relay rather than Nexus shelling into the phone. `native/atlas-os` policy/vault/immune modules are a separate OS experiment.

**Tests:** `local-control-bootstrap.test.ts`, `local-companion.test.ts`.

**vNext:** **Redesign** behind `device.control` + `runtimes/local`. Do not put companion protocol in Nexus. Stub this phase.

---

## 22. Browser / tool execution

**Where:** `tools/registry.ts`, `tools/mcp-tools.ts`, `mcp-discovery.ts`, `mcp-playwright.test.ts`, `tools/shell-execution.ts`, `python-execution.ts`, `web-fetch.ts`, `web-search.ts`, Playwright on `43103`.

**Duplicates:** MCP generic invoke vs first-class Playwright tools vs Website Studio browser QA.

**Strongest:** MCP discovery permission mapping (`permissionsForDiscoveredMcpTool`), path safety, web-fetch content-addressed cache + private-network block.

**Tests:** `mcp-discovery.test.ts`, `mcp-playwright.test.ts`, `filesystem-security.test.ts`, `agent-loop.test.ts`.

**vNext:** **Port permission mapping and SSRF rules** into execution/tool runtime. Browser is a capability (`browser.control`), not a dungeon.

---

## 23. Deployment

**Where:** `deploy/hetzner/` (installers, nginx, systemd, repair-workspace, verify-nexus-runtime), `.github/workflows/`, `scripts/check-host-local-deploy-contract.mjs`, `docs/ROOT_CANONICAL_CUTOVER.md`. Caspa `deployment/atlas-mountain-oidc/` deprecated.

**Duplicates:** `atlas-mountain-deploy.sh` vs `v2`; nginx `root` vs `v12` snippets; Caspa receiver.

**Strongest operational lessons:** serialized production deploys (`group: atlas-mountain-hetzner-production-v3`); `ExecStartPre` workspace repair; `ExecStartPost` runtime verify; release SHA in health (`ATLAS_RELEASE_SHA`); “build succeeding ≠ production healthy”.

**Weaknesses:** Historical cutover residue. Deploy scripts are host-specific, not a generic transactional deployer.

**vNext:** **Redesign** `ops/deploy` as immutable release + verify + rollback. Preserve verify-after-start and serialized promote. See ops stubs.

---

## 24. Observability

**Where:** Pino logging, `agent/trace-store.ts` (`agent_steps`), `tools/provider-performance.ts`, `providers/performance.ts` (TTFT, totalMs), recovery incidents, `xai/routes.ts` (unclear product surface).

**Duplicates:** agent traces vs tool_executions vs recovery incidents vs RunPod failure table.

**Strongest:** route resolution object (`attempted`, `usedFallback`) already on `assistant.started`. Failover records TTFT. Recovery fabric classifies incidents.

**Weaknesses:** No unified trace ID across request → route → provider attempts → job. Cost often missing. `xai` in Nexus is a coupling smell.

**Tests:** agent-loop / conversations tests emit stream events.

**vNext:** **Redesign** `platform/observability` with one trace ID. Route traces are a Nexus output; provider attempt spans are execution.

---

## 25. Backup / recovery

**Where:** Recovery *fabric* (incident classify/retry) is `services/nexus/src/recovery/` — **not** backup. Workspace repair: `deploy/hetzner/repair-workspace.sh`. SQLite files on Hetzner data disk. No documented restore runbook for “lost disk, new host”.

**Strongest:** repair-workspace canary before Nexus start; tenant-split DBs.

**Weaknesses:** Backup/restore is implicit. Guest vs owner DB restore not specified.

**vNext:** **Define now** in `ops/backup`. Restore procedure is a product requirement, not an afterthought.

---

## 26. UI shell

**Where:** `apps/desktop/` React/Vite, `docs/product-shell.md` (context | work | control), dungeon UI under `features/{writing,investigation,music,quantum,dungeons}/`, `docs/product/UI_APP_REQUIREMENTS.md`. Native: `native/atlas-os/`. No dedicated `apps/mobile` package (mobile is the same web app + gateway).

**Duplicates:** Caspa App.tsx, Shakespeare views, commons WHO web UI, craigs-navigator companion shell.

**Strongest:** product-shell zones. Dungeons already plug slots (`uiSlots` on investigation manifest) but still reimplement large workspace chrome.

**vNext:** **Redesign** one shell in `apps/web` (later desktop/mobile wrappers). Dungeons contribute routes/panels, not an outer app. Stub web this phase.

---

## 27. Conversation handling

**Where:** SQLite `conversations`/`messages` (migration 0001), Fastify routes in `app.ts`, stream protocol in shared `StreamEvent`, agent loop, desktop `features/chat/`.

**Duplicates:** Caspa assistant-routes, Shakespeare chat-ish write view.

**Strongest:** typed SSE events including `permission.required`, `stream.cancelled`, route resolution on start.

**Weaknesses:** Conversation is the persistence centre. Project context is bolted on. 16k send limit in `sendMessageSchema`.

**vNext:** **Redesign.** Conversations are objects that *point at* projects. They are not the project. Preserve SSE event shapes as a behavioural reference.

---

## 28. Durable project state

**Where:** `projects` table; project-scoped retrieval (`GET /api/projects/:id/context`); writing/investigation/research all have `project_id` nullable FKs. Desktop `ProjectPanel.tsx`, `WorkspaceLibraryPanel.tsx`.

**Duplicates:** Caspa `caspa-project-routes.ts` (Firebase projects).

**Strongest:** the *intent* that work belongs to a project. Investigation workspace is the most project-like (sources, captures, snapshots survive chats).

**Weaknesses:** conversations can be project-less. Settings JSON is schemaless. No project-level object index for universal search.

**vNext:** **Redesign.** Project is authoritative. Conversations, files, jobs, artefacts hang off it.

---

## Capability decision matrix (summary)

| Capability | Action | Why |
|---|---|---|
| Provider routing | Redesign | Config registry; Nexus must not execute |
| Failover/stream rules | Port rules → execution | Best-tested behaviour in the org |
| Health/discovery | Redesign | Registry field, not router side map |
| OpenAI/Anthropic/Gemini/Venice/Ollama | Port as adapters | Keep protocol out of Nexus |
| RunPod / Hetzner inference | Redesign as runtimes/providers | Split host vs GPU vs inference API |
| Writing/Caspa | Stub now; merge later | Domain must leave Nexus |
| Website Studio | Stub now; redesign dungeon | Preserve QA pipeline later |
| OSINT | Stub now; merge commons+Atlas later | Strongest jobs/SSE in commons |
| Investigation | Stub now; port evidence/provenance later | Strongest hash/manifest tests |
| Research | Stub now; platform jobs | Honest unavailable search |
| Storage | Redesign CAS | Artifacts are path-unique today |
| Jobs | Redesign one type | Four incomplete stores |
| Auth | Redesign; port native/guest split | Drop Firebase |
| Permissions | Redesign explicit scopes | Keep ALLOW/ASK/DENY |
| Local control | Stub; runtime later | Do not bury in Nexus |
| Browser/tools | Port SSRF + MCP perm map | Execution concern |
| Deploy | Redesign transactional | Keep verify-after-start |
| Observability | Redesign unified traces | Keep resolution + TTFT fields |
| Backup | New | Missing runbook |
| UI shell | Redesign later | Keep product zones |
| Conversations | Redesign vs projects | Keep SSE contract |
| Projects | Redesign as source of truth | Investigation is the model |

## Tests to treat as behavioural oracles (do not copy files blindly)

- `capability-routing.test.ts`, `failover-provider.test.ts`
- `investigation-snapshots.test.ts`, `investigation-run-recovery.test.ts`
- `filesystem-security.test.ts`, `mcp-playwright.test.ts`
- `ocrowley-commons/packages/osint/test/whoJobs.test.ts`
- Deploy contract scripts under `atlas-mountain/scripts/check-*-contract.mjs` (the *idea* of executable ops contracts)
