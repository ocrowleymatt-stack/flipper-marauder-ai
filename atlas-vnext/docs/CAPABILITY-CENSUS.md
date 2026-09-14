# Atlas vNext Capability Census

Ground-up audit for the design gate. Atlas Mountain is a **behavioural reference**, not an architectural template.

Disposition vocabulary: **KEEP BEHAVIOUR** | **REDESIGN** | **DISCARD** | **DEFER**.

## Inspection provenance (this audit)

| Source | Status this run |
|---|---|
| `ocrowleymatt-stack/flipper-marauder-ai` branch `cursor/atlas-vnext-design-gate-2e35` | Inspected (writable tree) |
| `ocrowleymatt-stack/Caspa` | Inspected (TypeScript/Node writing OS, duplicate routers, jobs, OSINT routes, PostgreSQL, Hetzner deploy) |
| `ocrowleymatt-stack/ocrowley-commons` | Inspected (jobs, SSE, ai-client, osint `who()`, policy default-deny, audit hash-chain, literary-*, research, persistence) |
| `ocrowleymatt-stack/TheBigBrother` | Inspected (Python OSINT scanner suite; behavioural reference only) |
| `ocrowleymatt-stack/Life-os` | Inspected (Daedalus/Themis approval gates; factory safety, not an Atlas dungeon) |
| `ocrowleymatt-stack/Shakespeare-` | Inspected (thin Gemini Studio literary UI) |
| `ocrowleymatt-stack/craigs-navigator` | Inspected; **out of scope** (companion/audio PWA) |
| `ocrowleymatt-stack/atlas-mountain` | **Not found / inaccessible** (`git clone` → repository not found; not in `gh repo list ocrowleymatt-stack`) |
| `ocrowleymatt-stack/atlas`, `Nexus`, `nexus-backend`, `nexus-dashboard`, `Life`, `spiderfoot-ui` | **Not found / inaccessible** |
| Pre-existing `/tmp/ref/atlas-mountain` clone | **Wrong tree**: `lystrosaurus/atlas-mountain` Java 21 / Spring Boot 4 / MySQL. This is **not** the Atlas estate. **DISCARD** as a census source. Duplicate branch `cursor/atlas-vnext-design-gate-99e9` treated that Java stub as Atlas Mountain; that census is untrustworthy and is not used here. |
| TypeScript Atlas Mountain (`services/nexus`, capability-router, failover, Writing, Website Studio, RunPod, Hetzner, companion) | **Not re-inspected this run.** File paths cited by the previous 2e35 author (`/agent/repos/atlas-mountain`) could not be opened. The user-authoritative estate is TypeScript/Node; dispositions below follow that, cross-checked against Caspa/commons. Do not treat Java/Spring Boot/MySQL as Atlas. |

hanflow and spiral-mind clones present under `/tmp/ref` are unrelated experiments. **DISCARD** as Atlas sources.

## 1. Failure modes in the inherited estate (from accessible code + specified AM behaviour)

1. **God-service mixing.** Routing, transport, jobs, and domain workflows share one process/tree (Caspa `src/services/*` plus the specified AM `services/nexus` bloat).
2. **Routing mixed with transport.** Caspa `unifiedRouter` / `llmRouter` / `cloudModelRouter` / `routerFailover` call providers, apply cooldowns, and parse failures in the same modules. commons `@ocrowley/ai-client` is an Ollama-first client with failover — policy + HTTP together.
3. **Storage fragmentation.** Caspa PostgreSQL manuscript versions + filesystem job JSON; commons atomic files; specified AM SQLite `content_base64` attachments. No CAS.
4. **Ad-hoc jobs.** Caspa JSON job store + archive; commons `@ocrowley/jobs` file-backed queue + SSE; OSINT `whoWorker` in-process; specified AM `setInterval` domain runners.
5. **Scattered permissions.** Caspa nginx/Authentik/Firebase; commons `@ocrowley/policy` default-deny; Life-os Themis mocked human gate; specified AM UI/Fastify/Themis vocabularies.

## 2. Matrix

| Capability | Where it actually lives (this run) | Duplicates | Strongest behaviour | Disposition |
|---|---|---|---|---|
| Provider routing / aliases | Specified AM capability-router (unverified this run); Caspa unified/llm/cloud routers; commons `ai-client` | many | Alias ranking + health exclusion (AM specified; Caspa cascade is weaker) | **REDESIGN** → Nexus (data-driven registry) |
| Model aliases `nexus/fast\|reason\|code\|vision\|cheap\|local\|frontier` | Specified AM; not present as named aliases in Caspa | Caspa intelligence modes | Seven vNext aliases only | **REDESIGN** → Nexus. Legacy AM aliases (`instant`, `deep`, …) **DISCARD** |
| Provider health / discovery | Caspa `publicHealth`, `freeModelPool`; specified AM `provider-health` / ollama-discovery | several | Configured vs healthy snapshot | **REDESIGN**: snapshot in Nexus; probes in execution |
| OpenAI / Anthropic / Gemini / Venice / Ollama adapters | Caspa `cloudModelRouter`, `SelfHostedLLMService`, Venice workflows; specified AM `providers/*` | commons ai-client | Tool-call streaming (AM specified); Caspa billing failover | **DEFER** into execution adapters. **DISCARD** as Nexus/Caspa control-plane copies |
| RunPod / GPU / Forge / Hetzner runtime | Caspa deploy + GPU-adjacent workflows; specified AM `compute/` `runpod-*.mjs` `deploy/hetzner/` | Caspa GitHub Action SSH | AM atomic symlink deploy (specified); Caspa live verify scripts | **DEFER** `runtimes/runpod`, `ops/deploy`. Keep operational lessons only |
| Retries / failover / streaming / tool buffering | Caspa `routerFailover` (billing/transient cooldown, can continue after hosted failure); specified AM failover + tool buffer + no-double-stream | commons ai-client | **KEEP BEHAVIOUR**: failover only before visible output; no second answer after tokens; buffer tool calls | **REDESIGN** → execution broker |
| Local / device control | Specified AM companion/relay; historical Flipper in this repo (current `main` has no device sources) | none here | Companion sandboxing (specified) | **DEFER** `runtimes/local` + `device.control`. **DISCARD** companion monolith copy |
| Browser tooling | Caspa `puppeteerBrowser`; specified AM Playwright MCP | two | MCP/browser control as execution, not Nexus | **DEFER** execution/browser |
| Authentication | Caspa Firebase + nginx/Authentik; specified AM native-auth sidecar | several | PKCE ideas (specified) | **DEFER** `platform/auth`. **DISCARD** nginx subrequest sidecar as the model |
| Permissions | commons `@ocrowley/policy` default deny; Life-os Themis; Caspa operatorAccess; specified AM scopes | several | commons default-deny + explicit scopes | **REDESIGN** → `platform/permissions` (default deny in code) |
| Jobs / background execution | Caspa `jobQueueService` (idempotency keys, JSON persist, archive); commons jobs + SSE + `whoWorker`; specified AM per-domain runners | many | commons staged jobs + SSE; Caspa idempotency | **REDESIGN** → one `platform/jobs` |
| Durable project state | Caspa `hybridCoreRepository` PostgreSQL revisions; specified AM `projects.ts` | two | Caspa immutable versions + conflict | **REDESIGN** → `platform/projects`. Conversation is not source of truth |
| File/object storage / attachments | Caspa FS + Postgres content; commons persistence files; specified AM SQLite base64 | many | SHA-256 checksums (Caspa) | **REDESIGN** CAS. **DISCARD** blobs/base64 in relational rows |
| Provenance / audit | Caspa `jobProvenance`; commons `@ocrowley/audit` hash-chain | two | hash-chain + job provenance | **REDESIGN** `platform/provenance` |
| Observability | Caspa doctor/diagnostics workflows; specified AM trace-store | several | EWMA latency (specified) | **DEFER** `platform/observability` (interface now) |
| Website Studio | Specified AM `site-lifecycle` / `dev-preview` (unverified this run); Caspa publication/workspace rebuild | Caspa adjacent | Quota/prune, preview vs prod (specified) | **REDESIGN** `dungeons/website` later. **DISCARD** Nexus-mounted preview servers |
| Writing / Caspa | **Caspa is the richest writing product** (GoldPipeline, StoryBible, ChapterStructure, PlotArchitect, literary polish, PG revisions); commons literary-*; Shakespeare- prompts; specified AM claim ledger | many | Caspa craft + claim-ledger behaviour | **DEFER** `dungeons/writing`. One Book Project. **DISCARD** parallel writing DBs / Caspa UI port now |
| Investigation | Specified AM investigation executor (unverified); no equal in accessible repos | — | Multi-role challenge loop (specified) | **DEFER** `dungeons/investigation` |
| Research | commons `@ocrowley/research`; Caspa research routes; specified AM federated runner / Arcanum / SpiderFoot | several | Shared retrieval + provenance | **REDESIGN** contracts; **DEFER** dungeon. Do not duplicate retrieval per dungeon |
| OSINT | **commons `@ocrowley/osint` `who()`** + SSE jobs + SpiderFoot/BigBrother bridges; TheBigBrother 21 modules; Caspa `osintAnalystService` (weaker); specified AM `bigbrother.ts` in Nexus | many | commons typed who() + BigBrother scanners | **REDESIGN** `dungeons/osint` on platform jobs. **DISCARD** Nexus-embedded OSINT. Do not vendor BigBrother |
| Music | Caspa verify-atlas-music workflow; specified AM ACE-Step/RunPod | — | GPU in runtimes | **DEFER** `dungeons/music` |
| Deployment | Caspa `deploy-caspa.yml` + nginx identity verify; specified AM hetzner atomic SHA symlink | many one-off Actions | Immutable SHA, verify before success, rollback | **KEEP BEHAVIOUR** as ops lessons. **DISCARD** `/v12`, OpenWebUI probes, needle scripts, Action sprawl |
| Backup / recovery | Caspa `localBackupService`, `backup-and-verify.sh`, job archive; no estate-wide CAS backup | ad-hoc | Verify after backup | **REDESIGN** documented strategy (metadata PG + object store) |
| UI shell / conversation handling | Caspa React app; Shakespeare-; specified AM desktop App.tsx | three | Viewport contract (specified) | **DEFER** `apps/web`. Chat is not durable state |
| Search / indexing | commons research/osint indexes; Caspa knowledge index | silos | Shared index later | **DEFER** `platform/search` |
| Schema migration / feature flags | Caspa/commons ad-hoc; specified AM copy-migration scripts | scripts | Versioned schemas + flags | **REDESIGN** flags interface now; **DISCARD** one-off patch scripts |
| Conversations | Caspa assistant routes; OpenWebUI probes in Caspa workflows | OpenWebUI | Chat ephemeral | **DISCARD** OpenWebUI compatibility as a contract |

## 3. Outside Atlas Mountain (must not be missed)

1. **OSINT** is primarily commons + TheBigBrother, not AM.
2. **Writing craft** is primarily Caspa, not AM.
3. **Shared jobs/SSE/ai-client/policy/audit** live in ocrowley-commons.
4. **Approval/risk factory** lives in Life-os Daedalus/Themis (not an Atlas dungeon).
5. **Flipper/local radio** historically lived in this repo; current `main` has no device sources.
6. **craigs-navigator**, hanflow, spiral-mind, and the Java `lystrosaurus/atlas-mountain` stub are not Atlas capabilities.
7. **Caspa** also carries duplicate provider routers, Venice council experiments, and a large GitHub Actions deploy/diagnostics corpus — operational lessons only.

## 4. Tests worth preserving later (not copied now)

- Caspa: `unifiedRouter`, `routerFailoverSurvival`, `jobQueueService` / archive, literary pipeline tests — as *acceptance behaviour*.
- commons: `osint` who/dossier tests; jobs SSE tests; policy default-deny.
- Life-os: Themis no-go / human-approval stance.
- Specified AM (when the TypeScript tree is available): capability-routing, failover-provider, writing-commission, claim-ledger, investigation-assurance, attachments as *negative* examples for blobs-in-SQL.

Preserve as acceptance behaviour, reimplemented against vNext packages. Do not copy files.

## 5. Product classification of this branch vs `main`

See [PRODUCT-CLASSIFICATION.md](./PRODUCT-CLASSIFICATION.md). Dungeon packages are **thin skeletons**. No production migration in this PR.
