# Atlas vNext Architecture Review (Design Gate)

**Repo under review / the only writable tree:** `flipper-marauder-ai`  
**Branch:** `cursor/atlas-vnext-design-gate-2e35`  
**Reference (read-only):** Atlas Mountain, Caspa, Shakespeare-, ocrowley-commons, TheBigBrother, Life-os, craigs-navigator, and the previous agent’s Atlas Mountain vNext commit.

This review is the design gate. It is not a product migration.

---

## 1. flipper-marauder-ai is the only repo being modified

**Verified.** All commits, pushes, and the pull request for this work are in `https://github.com/ocrowleymatt-stack/flipper-marauder-ai`.

The previous agent put vNext work on Atlas Mountain branch `cursor/atlas-vnext-architecture-2e35`. That tree is treated as **reference only**. This agent did not add commits, push, or open a PR on Atlas Mountain.

Design-gate files live in `atlas-vnext/` so the repository root (historically a Flipper Zero app; currently a short Atlas vNext README) is not overwritten as if it were Atlas Mountain.

---

## 2. All old Atlas-related repos were treated as read-only reference sources

Inspected, not modified:

| Clone | Role |
|---|---|
| `/agent/repos/atlas-mountain` | Behavioural reference; previous agent’s docs/contracts/nexus |
| `/agent/repos/Caspa` | Writing OS, duplicate routers, jobs, OSINT routes |
| `/agent/repos/Shakespeare-` | Gemini Studio literary app |
| `/agent/repos/ocrowley-commons` | Shared TS/Python libraries including OSINT `who()`, jobs, ai-client |
| `/agent/repos/TheBigBrother` | Python OSINT scanner suite (21 modules) |
| `/agent/repos/Life-os` | Daedalus safety gates / Themis approvals |
| `/agent/repos/craigs-navigator` | Unrelated companion/audio PWA |

No bulk copy of implementation from any of them.

---

## 3. Capabilities found outside Atlas Mountain

### OSINT (strongest signal outside AM)

- **`ocrowley-commons/packages/osint`**: `who()` people lookup, dossier/entity index, WHO HTTP API + SSE jobs, SpiderFoot / SpiderDash / BigBrother bridges, default-deny case auth. This is the most complete *typed* OSINT product surface.
- **`ocrowley-commons/python/ocrowley_osint`**: module registry + Ahmia helpers; BigBrother sidecar.
- **`TheBigBrother`**: username scanner (`scanner.py`, `sites.py`), 21 intel modules (domain oracle, mail tracer, code hunter, wayback, paste dragnet, breach vault, dark watch, GEOINT, SIGINT, etc.), AI analyst orchestrator. Behavioural reference for scanners — **do not vendor**.
- **`Caspa/src/routes` + `osintAnalystService`**: writing-adjacent OSINT analyst prompts; weaker than commons.
- **AM `services/nexus/src/research/bigbrother.ts`**: Nexus-embedded OSINT — reject this placement.

**Recommendation:** future `dungeons/osint` consumes commons *contracts* and BigBrother *behaviour*, runs on `platform/jobs` + CAS. Nexus stays out.

### Caspa / Writing

- **Caspa**: GoldPipeline, StoryBible, ChapterStructure, PlotArchitect, literary polish, PostgreSQL project revisions, jobQueueService, nginx/Authentik identity, Hetzner deploy. The richest writing *product*.
- **Shakespeare-**: thin Gemini AI Studio writing UI / prompts.
- **AM `services/nexus/src/writing/`**: claim ledger, stylometry, commission runner — valuable behaviour trapped in the god-service.
- **commons**: `literary-rules`, `literary-prompts`, `manuscript`, `story-memory`, `coherence`, `quality`, `export`.

**Recommendation:** `dungeons/writing` later; merge Caspa craft + AM claim ledger. Do not keep three routers.

### Local control / devices

- **AM** `scripts/atlas-companion.mjs` (~1100 lines), `atlas-device-relay.mjs`, `services/nexus/src/local-control/`.
- **flipper-marauder-ai** (historical): Flipper Zero BLE/serial. Current `main` is a greenfield README only; no Flipper sources remain in-tree.
- Caspa has no equivalent companion daemon.

**Recommendation:** future `runtimes/local` + `device.control` permission. Not Nexus.

### Deployment

- **AM** `deploy/hetzner/atlas-mountain-deploy.sh`: immutable SHA, atomic symlink, rollback — strongest *behaviour*. Coupled to nginx `/v12` shims and string-needle `check-*-contract.mjs` scripts — reject those mechanisms.
- **Caspa** `deploy/` + GitHub Action SSH to Hetzner + `verify-nginx-identity.sh`.
- **commons** `docs/DEPLOY_WHO.md` Docker WHO stack.

**Recommendation:** future `atlas-vnext/ops/deploy` redesigned from AM behaviour, without `/v12` or needle scripts.

### Provider routing

- **AM** `capability-router.ts`, `auto-router.ts`, `hybrid-auto-policy.ts`, `failover-provider.ts` — strongest alias + failover *behaviour*, fatally mixed with transport.
- **Caspa** `unifiedRouter.ts`, `llmRouter.ts`, `aiRouterPolicy.ts`, `cloudModelRouter.ts`, `routerFailover.ts`.
- **commons `@ocrowley/ai-client`**: Ollama-first multi-provider client with failover (transport + policy mixed).

**Recommendation:** Nexus = AM alias/ranking behaviour only. Execution = failover/stream/tool-buffer behaviour. Discard Caspa routers as the control plane.

### Shared libraries

commons is a library mine, not a runtime:

| Keep as behavioural reference | Do not import as platform |
|---|---|
| `@ocrowley/jobs` staged jobs + SSE | Job *engine* is `platform/jobs` |
| `@ocrowley/ai-client` failover | Execution broker |
| `@ocrowley/osint` who/dossier contracts | `dungeons/osint` |
| `@ocrowley/policy` + Life-os Themis | `platform/permissions` |
| `@ocrowley/audit` hash-chain | provenance/audit later |
| `@ocrowley/persistence` atomic files | not a substitute for CAS |
| literary-* packages | `dungeons/writing` |

Life-os Daedalus (planner/builder/Aegis/Iris/Themis) is a **factory safety scaffold**, not an Atlas dungeon.

craigs-navigator is out of scope (sleep/audio companion).

---

## 4. Duplicated or conflicting implementations — what to keep

| Capability | Duplicates | Keep (behaviour) | Discard / do not port |
|---|---|---|---|
| Routing policy | AM capability-router, Caspa unified/llm/cloud routers, commons ai-client | AM alias ranking, redesigned as Nexus | Caspa routers as control plane; AM god-service |
| Transport / retry / SSE | AM failover-provider + streaming/, Caspa routerFailover, commons ai-client + SSEBroadcaster | AM transactional tool buffer + no-double-stream invariant, in **execution** | Mixing this into Nexus |
| Jobs | AM per-domain runners, Caspa jobQueueService, commons CaspaJobService | commons staged-job + AM restart recovery *ideas* in `platform/jobs` | Per-dungeon `setInterval` runners |
| Storage | AM attachments SQLite base64, Caspa Postgres+FS, commons persistence | New CAS | attachments-in-sqlite |
| OSINT | commons who(), TheBigBrother, AM bigbrother.ts, Caspa osint routes | commons contracts + BigBrother scanners as dungeon | Nexus-embedded OSINT |
| Writing | Caspa, Shakespeare, AM writing/, commons literary-* | Caspa craft + AM claim ledger | Three UIs, Nexus writing/ |
| Permissions | AM permissions engine, Life-os Themis, commons policy | AM scopes + Themis risk gates as `platform/permissions` | UI-scattered checks |
| Auth | AM native-auth sidecar, Caspa Firebase/Authentik | Redesign `platform/auth` later | Nginx subrequest sidecar as the model |
| Deploy | AM hetzner script, Caspa SSH action | AM atomic symlink behaviour | `/v12`, needle contract scripts, archiveB64 |

---

## 5. Nexus remains routing / discovery / policy only

In this PR, `@atlas-vnext/nexus` contains:

- `NexusRegistry` — declarative models + recorded health
- `NexusRouter` — alias + explicit route resolution

It does **not** contain dungeon logic, `fetch`, HTTP modules, retries, circuit breakers, SQL, jobs, or Caspa/OSINT. Architecture tests fail if those imports appear (TypeScript AST + `package.json` dependencies).

Health is a **snapshot field**. Probing providers is not Nexus’s job.

---

## 6. Provider transport, retries, circuit breakers, streaming live in execution

`@atlas-vnext/execution` owns:

- `ProviderAdapter` (transport interface)
- `CircuitBreaker`
- `ExecutionBroker` — candidate failover **before** visible text, no second answer after tokens, tool-call buffer, per-candidate retries
- `MockAdapter` only (proof). Production HTTP adapters must land in this layer later.

Execution depends on contracts, **not** on Nexus. It consumes `RouteDecision`.

---

## 7. Jobs, events, storage, provenance, permissions, projects are platform primitives

Empty shells under `platform/{projects,jobs,events,storage,provenance,permissions}`. Dungeons do not own these. This PR does **not** ship in-memory fake engines (the previous AM vNext PR did); durable implementations are a later phase.

---

## 8. Architecture-boundary tests actually prevent forbidden imports

`atlas-vnext/tests/architecture/` walks `packages/`, `platform/`, and `dungeons/`, parses TypeScript with the compiler API (import/export declarations, `import()`, `require()`, `fetch()` calls, class names), classifies layers, and reads workspace `package.json` dependencies.

Live tree must report **zero** violations.

Overlays prove failure when:

- Nexus calls `fetch` or imports `undici` / `node:https`
- Nexus imports dungeons, jobs, storage, or `@ocrowley/osint`
- Nexus `package.json` depends on execution, better-sqlite3, or axios
- Nexus defines `CircuitBreaker`
- A dungeon imports another dungeon
- A dungeon imports `platform/execution/src/adapters` or `openai`
- Execution imports Nexus or a dungeon

This is not Atlas Mountain’s `scripts/check-*-contract.mjs` needle scanner.

---

## 9. First PR does not bulk-copy legacy implementation

Shipped code is small: Zod contracts, a registry/router, an execution broker, interfaces, tests. Not copied: `services/nexus`, Caspa `src/services`, commons package implementations, nginx shims, patch scripts, job runners, provider HTTP adapters, OSINT scanners.

Previous AM vNext in-memory jobs/CAS/permissions implementations were **not** brought over.

---

## 10. WHAT WE DELIBERATELY DID NOT PORT

See [WHAT-WE-DELIBERATELY-DID-NOT-PORT.md](./WHAT-WE-DELIBERATELY-DID-NOT-PORT.md).

Independence from old Atlas Mountain structure:

| Old AM pattern | vNext stance |
|---|---|
| turbo `apps/*` + `services/*` as the product | `atlas-vnext/` design-gate packages only; apps later |
| `services/nexus` god-service | thin `@atlas-vnext/nexus` |
| `/v12` nginx shims | rejected |
| per-domain job runners | `platform/jobs` (shell) |
| attachments in SQLite | CAS (shell) |
| `check-*-contract.mjs` string needles | import-graph tests |

---

## Residual risks

- Durable jobs/CAS/auth are unspecified at runtime until a later PR; do not pretend in-memory maps are production.
- OSINT/Caspa behaviour is documented, not implemented — product migration is explicitly out of scope.
- Flipper Zero sources are absent from current `main`; local-device work must not assume they still live at repo root.
- Previous AM vNext branch still exists beside the old monorepo; it must not be treated as the source of truth going forward.
