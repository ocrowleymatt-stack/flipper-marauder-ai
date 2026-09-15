# Production readiness and cutover gate

Stacked on accepted Caspa head `cursor/vnext-caspa-writing-99e9` @ `46cd770`. Tools/auth and Workbench are included in that lineage and are **not merged to main**. This tranche does not flatten or cherry-pick onto stale main.

Cutover remains **human-gated**. CI green is not production.

## Stacking record

| Lineage | Ref | CI | Merge |
|---|---|---|---|
| main | `26428d9` (PR #7) | SUCCESS | merged |
| tools/auth | `cursor/vnext-tools-auth-platform-99e9` @ `49e6b15` | 34882773498 SUCCESS | unmerged |
| Workbench | `cursor/vnext-workbench-ui-99e9` @ `7860c42` | 34902930457 SUCCESS | unmerged, stacked on tools |
| Caspa | `cursor/vnext-caspa-writing-99e9` @ `46cd770` | 34907583904 SUCCESS | unmerged, stacked on Workbench |
| **this tranche** | `cursor/vnext-production-readiness-99e9` | stacked on Caspa | draft PR, do not merge as cutover |

No open GitHub PRs existed for tools/Workbench/Caspa (they were branch-only). No duplicate production-readiness branch was found.

## Non-negotiable contracts (unchanged)

- Nexus owns WHERE. Execution owns HOW. Dungeons stay thin. RunPod stays behind execution.
- No silent post-visible provider switch. Pre-output failover only.
- No blind replay of uncertain side effects. Tools are buffered. Approvals are durable and server-side.
- Tenant-derived access. Authority is not a flag and not Behaviour.
- Durable documents and real provenance. CAS never invents bytes.
- No browser-owned security.

If a production concern requires weakening a contract: **stop for a human decision**. None of the implementations in this tranche weaken those contracts.

---

## 5. Deployment topology (actual components)

| Component | Responsibility | State | Scale | Startup | Depends on | Health | Shutdown | Failure impact |
|---|---|---|---|---|---|---|---|---|
| `apps/host` Node process | HTTP/SSE, auth cookies, Workbench/Caspa routes, composition root | Stateless wrt durable data; in-process SSE subscribers, rate limiter, Nexus health snapshots, RunPod scheduler file | 1 ready instance is the honest HA story; extra instances need sticky SSE | Config validate → migrate → `recoverOnStart` → listen | PostgreSQL, CAS filesystem, optional providers | `/api/health/live` process; `/api/health/ready` deps | SIGTERM: stop accepting, stop tools, end pool, close server (bounded) | Process death interrupts in-flight streams; durable rows survive |
| `apps/web` static dist | Workbench UI | Stateless | CDN or same process `ATLAS_VNEXT_STATIC` | Built at image build | Host API | n/a | n/a | UI down; API may still work |
| PostgreSQL 16 | Metadata, sessions, approvals, jobs, documents | Stateful | 1 primary (this candidate) | Must accept connections before ready | Disk | `SELECT 1` | Host ends pool; do not kill PG mid-tx without drain | Ready=false; no silent fallback |
| Filesystem CAS | Blobs `sha256/<aa>/<bb>/<hash>` | Stateful immutable objects | Local disk or mounted volume | Directory exists | Disk | `physicalBytes()` | None special | Missing object is observable; bytes are not invented |
| Provider APIs | Model tokens | External | n/a | Keys optional; missing = unavailable | Network | Execution probes → Nexus snapshots | Abort in-flight HTTP | Failover only before visible output |
| RunPod | On-demand GPU | External + `runtime.json` on host disk | Max 1 paid pod | Scheduler reconcile | RunPod API | scheduler health | Idle stop / persist | Not in Workbench/Caspa; execution-owned |

No Kubernetes manifests are added. `atlas-vnext/Dockerfile` is a packaging sketch, not a production cluster.

## 6. Config / secrets

Catalogue: `PRODUCTION_CONFIG_CATALOGUE` in `apps/host/src/production-config.ts`. Validate with `npm run config:validate` and `tsx scripts/validate-config.ts --production`.

Production **fails loud** without: PostgreSQL URL, `ATLAS_TENANT_ID`, `ATLAS_SESSION_SECRET`, `ATLAS_ALLOWED_ORIGINS` (no `*`), `ATLAS_CAS_ROOT`. Mock providers and the JSON file store are **forbidden**. Missing provider API keys mark that provider unavailable; they do not crash the host and are not written to logs or frontend.

## 7. Migrations

Ordered `001`–`007`, transactional, checksummed, forward-only. Failed SQL rolls back that version and is not recorded. Empty→latest, v1→latest, interrupted migration, and checksum mismatch are tested. **No DROP DATABASE / DROP SCHEMA as recovery.** Destructive table drops are not part of this product.

## 8. DB connections

pg pool with `ATLAS_DB_*` timeouts. Idle client errors are logged. Transient connection errors retry **at most twice** (not inside an open transaction). Startup connect retries are bounded the same way, then fail closed. Closed kernel rejects work (`PersistenceClosedError`). No infinite retry. No silent data loss.

## 9. CAS durability

Put verifies hash, dedups, atomic rename. Get verifies hash. Missing object → `CasMissingError`. `FilesService.inspectCas` reports metadata/object divergence. Restart + tenant isolation already covered by files tests. Provenance stores hashes, not bytes.

## 10. Backup / restore

Minimum viable: `pg_dump` of PostgreSQL + copy of the CAS root + secret manager copy of config (not the DB). Restore to a **new** cluster, hash-verify CAS objects against metadata pointers, then canary. Automated drill (CI, when Postgres is present): project, file bytes, provenance, conversation, pending tool approval, Caspa document/version via kernel reopen + CAS directory copy. Dropping tables is not a restore.

## 11. Startup / restart / shutdown

Production host refuses to listen until ready. `recoverOnStart` fails in-flight executions/documents and marks uncertain tools uncertain (no blind replay). Shutdown: `ShutdownController` stops mutating traffic and tools; pool end; bounded `ATLAS_SHUTDOWN_TIMEOUT_MS`.

## 12. Health

`/api/health/live` = process alive. `/api/health/ready` and `/api/health` are 503 when critical deps fail or shutdown has begun. Production requires postgres=`ok` and cas=`ok`. Dead DB is not ready. Endpoints do not include URLs, secrets, or cookies.

## 13–15. Observability, metrics, tracing

Structured JSON logs via `logPlatform` with request correlation (`requestId`, tenant, actor, project, conversation, run, route, attempt, tool, approval, document, provider) from `AsyncLocalStorage`. Redaction strips secrets, tokens, cookies, prompts, file bodies. Metrics are low-cardinality (`route_class`, `outcome`, `provider`, `code`, `component`) on `/api/metrics`. HTTP → actor → project/run is attached at the host; Nexus/Execution already record attempts on the execution record.

## 16. Error classification

Host maps: unauthenticated, unauthorised, not_found, conflict, validation, rate_limit, payload_too_large, provider_unavailable, fail_before/after_visible, tool_denied/uncertain, persistence/CAS unavailable, shutting_down, timeout, kill_switch. Cross-tenant existence is `404` + generic deny.

## 17–19. Rate limits, resource limits, timeouts

Platform `PlatformRateLimiter` (tenant+actor from the session, never a client tenant header; not in Dungeons). Resource guard: streams, runs, bodies, context files, generated/tool-arg bytes. Tool engine: concurrency, pending approvals, per-tenant quota, argument size. Timeouts: HTTP/provider/RunPod/DB/CAS/tools/stream idle/startup/shutdown in `readTimeoutContract`. Consistent with failover (provider timeout before tokens is retryable) and uncertain tools (no replay).

**CONDITIONAL:** rate limiter, tool quota, stream/run guards, and SSE subscribers are **per process**. Multi-instance deployments multiply those ceilings unless a shared limiter is added later.

## 20–22. Provider / RunPod / tool drills

Covered by execution broker tests, Mountain compat, RunPod scheduler tests, tool recovery tests, and `tests/production/failure-injection.test.ts`. No hardcoded fallback lists; Nexus candidate chains + health. RunPod is not referenced from Workbench/Caspa.

## 23–25. Auth, headers, CORS

Secure HttpOnly SameSite=Lax cookies; Secure in production. CSRF header required for mutating cookie requests. Origin allowlist required in production. No wildcard+credentials. CSP, frame deny, nosniff, referrer, permissions-policy; HSTS only with `ATLAS_TLS=1`. SSE no longer forces `Access-Control-Allow-Origin: *`.

## 26–30. Tenant, Authority, Workbench, Caspa, concurrency

Existing suites remain. Production smoke adds guessed IDs, CSRF, Caspa stale revision, logout. Optimistic revisions and idempotency keys are the multi-instance correctness layer (not process mutexes).

## 31. Multi-instance inventory

| In-memory | Correctness if multi-instance | Action |
|---|---|---|
| Sessions, approvals, invocations, jobs, documents, conversations | Durable in PostgreSQL | Keep |
| SSE live fan-out | Other instance cannot push the same stream; reconnect uses event replay | CONDITIONAL; sticky sessions or accept reconnect |
| `ConversationRuntime.inflight` abort | Cancel on another instance updates DB but may not abort the owner stream | CONDITIONAL |
| Rate limiter / tool quota / stream guards | Per-instance ceilings | CONDITIONAL |
| Nexus health snapshots | Each instance probes | OK |
| Feature flags | Shared env | OK |
| RunPod `runtime.json` | **One scheduler per paid pod**; two hosts can fight the pod | CONDITIONAL / do not run two live schedulers |

## 32–34. Build, packaging, supply chain

`npm ci` + lockfile. Frontend Vite build + backend TypeScript via `tsx` (runtime dependency, not a hidden dev-only start). Dockerfile is optional packaging. `npm run advisories:classify` classifies npm audit; this tranche does not silently patch unrelated upgrades.

## 35–36. Retention and privacy

Event retention hook and site revision GC already exist; they do not silently delete conversations, files, or documents. Logs must not contain secrets/tokens/cookies/files/prompts/tool creds/source dumps (redaction tests).

## 37. CI production gates

Existing gates kept. Added: `test:production`, `config:validate`, advisories classify. Postgres service still runs persistence/files/Caspa/tools/Mountain.

## 38. Failure-injection harness

`tests/production/failure-injection.test.ts`: DB isolation, provider down before/after visible, CAS missing, tool uncertain, stale revision, kill-switch ≠ Authority.

## 39–41. Rollback and cutover

See [RUNBOOKS.md](./RUNBOOKS.md) and the cutover section below. Dual-write is **not** justified: vNext is a greenfield store, not a sidecar in Mountain. Legacy Mountain/Caspa data is **not** migrated in this tranche.

### Cutover data classification

| Data | Disposition |
|---|---|
| vNext PG + CAS created after enablement | Must migrate / back up |
| Atlas Mountain / historical Caspa product DBs | Read-only legacy until a later import job; not in this PR |
| Provider keys | Secret manager; not in git |
| JSON `.data/state.json` | Disposable / local-dev only |
| In-process rate-limit counters | Disposable |

## 42. Feature flags / kill switches

`ATLAS_FLAG_TOOLS`, `ATLAS_FLAG_GENERATION`, `ATLAS_FLAG_DUNGEON_WRITING`, `ATLAS_KILL_PROVIDERS`. Disable surfaces; they do **not** grant Authority.

## 43. Smoke sequence (automated in `tests/production/smoke.test.ts`)

1. Liveness  
2. Readiness  
3. Auth cookie flags  
4. CSRF reject  
5. Create project  
6. Upload → CAS hash  
7. CAS object present  
8. Create conversation  
9. Guessed foreign project id → generic 404  
10. List approvals  
11. Create Caspa document  
12. Stale Caspa edit → 409  
13. Logout  
14. Shutdown → not ready  
15. Liveness still true  
16. Timeout contract present  
17. Kill switches default on  

## 44. Performance baseline

`tests/production/performance.test.ts` records startup and ex-model API latency. Pathological unbounded queries were not introduced here; list endpoints remain tenant-scoped. No speculative index rewrite.

## 45–46. Ops docs / runbooks

This file + [RUNBOOKS.md](./RUNBOOKS.md) + [BACKUP-AND-RECOVERY.md](./BACKUP-AND-RECOVERY.md) + [DEPLOYMENT.md](./DEPLOYMENT.md).

## 47. GO / NO-GO matrix

Statuses: PASS / FAIL / CONDITIONAL / N/A. GO for **cutover** requires no unresolved critical FAIL. This table is not massaged.

| # | Item | Status | Evidence / notes |
|---|---|---|---|
| 5 | Deployment topology | PASS | Documented actual host, web dist, PG, CAS, providers, RunPod. No invented K8s. |
| 6 | Config/secrets | PASS | `readProductionHostConfig` fails loud; secrets not in public view/logs/frontend. |
| 7 | Migrations | PASS | Empty→latest, v1→latest, interrupted rollback, checksum mismatch. Forward-only. |
| 8 | DB connections | PASS | Pool timeouts; ≤2 transient retries; startup fail-closed; closed kernel rejects work. |
| 9 | CAS durability | PASS | Hash stable, dedup, missing detected, divergence logged, never invents bytes. |
| 10 | Backup/restore | PASS | pg_dump+CAS copy story; CI drill restores project/file/provenance/conversation/approval/document. Not a vendor WAL replica. |
| 11 | Startup/restart/shutdown | PASS | Ready-before-listen in production; recoverOnStart; bounded graceful shutdown. |
| 12 | Health | PASS | Live ≠ ready. Dead DB → 503. No secrets on health. |
| 13 | Observability logs | PASS | Structured JSON + correlation ids; prompt/file/secret redaction tests. |
| 14 | Metrics | PASS | Low-cardinality `/api/metrics`. No ID labels. In-process. |
| 15 | Tracing | CONDITIONAL | Request correlation ALS HTTP→actor→route. No OpenTelemetry exporter. |
| 16 | Error classification | PASS | Host mapper; cross-tenant → generic 404. |
| 17 | Rate limiting | CONDITIONAL | Platform tenant/actor limiter. Per-process (multiplies across instances). |
| 18 | Resource limits | PASS | Bodies, streams, runs, approvals, tool args, context files. Rejects deliberately. Per-process stream/run guards. |
| 19 | Timeouts | PASS | HTTP/provider/RunPod/DB/tool/stream idle/startup/shutdown contract. |
| 20 | Provider failure drills | PASS | Failover before visible; terminal after visible. No hardcoded fallback list. |
| 21 | RunPod drills | PASS | Existing scheduler tests (unavailable, idle, recover). Not in Workbench/Caspa. |
| 22 | Tool side-effect drills | PASS | Uncertain not replayed; restart; approval idempotency via durable rows. |
| 23 | Auth/session | PASS | HttpOnly SameSite; Secure in production; CSRF; origin allowlist; logout; no prod bootstrap. |
| 24 | Security headers | PASS | CSP, frame, nosniff, referrer, permissions-policy; HSTS if `ATLAS_TLS=1`. Vite CSS minify warning remains (pre-existing). |
| 25 | CORS | PASS | No wildcard+credentials. SSE no longer forces `*`. |
| 26 | Tenant isolation | PASS | Adapter + HTTP guessed-id smoke. Generic deny. |
| 27 | Authority | PASS | Existing suite + kill-switch ≠ Authority. |
| 28 | Workbench failure surfaces | PASS | Existing Workbench tests + host health/CSRF/CAS missing. |
| 29 | Caspa | PASS | Existing Caspa tests + stale 409 smoke. Long commissions not pulled. |
| 30 | Concurrency | PASS | Optimistic revisions, idempotency keys. Not process mutex. |
| 31 | Multi-instance | CONDITIONAL | Durable: sessions/approvals/jobs/docs. In-memory: SSE fan-out, rate limits, RunPod `runtime.json` (single scheduler). |
| 32 | Production build | PASS | lockfile, `npm ci`, frontend Vite, backend `tsx` as a runtime dependency. |
| 33 | Container/packaging | PASS | Dockerfile sketch. No Kubernetes. |
| 34 | Supply chain | PASS | 2 moderate vitest advisories classified informational; no critical/high runtime blockers patched. |
| 35 | Retention/cleanup | PASS | Existing event/site GC; no silent user-data delete added. |
| 36 | Privacy logging | PASS | Redaction tests include cookie/token/prompt. |
| 37 | CI production gates | PASS | Existing gates kept; added production tests + config validate + advisories. |
| 38 | Failure-injection harness | PASS | `tests/production/failure-injection.test.ts`. |
| 39 | Rollback plan | PASS | App vs schema vs data vs cutover in RUNBOOKS. |
| 40 | Cutover strategy | PASS | Greenfield; dual-write not justified. |
| 41 | Cutover data | PASS | Classified. Legacy Mountain/Caspa not imported. |
| 42 | Feature flags/kill switches | PASS | Env flags. Not Authority. |
| 43 | Smoke 1–17 | PASS | `tests/production/smoke.test.ts`. |
| 44 | Performance baseline | PASS | Startup budget; no pathological query rewrite. |
| 45 | Ops docs | PASS | PRODUCTION.md describes what exists. |
| 46 | Runbooks | PASS | RUNBOOKS.md. |
| 47 | This matrix | PASS | Honest CONDITIONAL rows, no hidden FAIL. |
| 48 | Human cutover gate | N/A (always human) | Even all-PASS is not permission to switch DNS. |
| — | Stack merged to main | FAIL (cutover) | tools/Workbench/Caspa/this PR are unmerged. Cutover cannot proceed until a human merges the stack. |

**Tranche verdict:** operational production **candidate** is defensible for a single-instance PostgreSQL+CAS deploy of this stack.

**Cutover verdict: NO-GO** until a human merges the unmerged stack onto main and accepts the CONDITIONAL multi-instance/RunPod-scheduler rows.

## 48. Human gate

Even if all tests pass, DNS, secret rotation, production migration apply, and traffic switch require a human.

