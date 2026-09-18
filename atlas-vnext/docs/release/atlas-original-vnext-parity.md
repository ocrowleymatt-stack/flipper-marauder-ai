# Original Atlas vs Atlas vNext — replacement parity

Compared:

- Original Atlas Mountain live: `https://atlas.ocrowley.com` (Hetzner `116.202.24.63`, nginx, native `/login`, `/auth/status` `configured=true` `googleEnabled=false`). Source: `ocrowleymatt-stack/atlas-mountain` `main` @ `5cc7a964059d3f6583bb5a8284f85185c86f1cb1`.
- Atlas vNext: this repository `main` @ `da7ff6f9369735cf47a52f964af5ac0bf12cd62e` plus this staging tranche (Help & Repair host/UI + isolated staging install).

This is a **user-observable** comparison, not an architecture-intention list. Architecture cleanliness is not scored as IMPROVED unless the owner can see the difference.

Staging gate: **no P0**, **no P1 on the owner staging workload**. P2s below are documented and bounded.

## Verdict

**STAGING GATE: PASS.** vNext is at or above original Atlas for the first-use surface (authenticate, Workbench, project, files, conversation, Caspa/Writing, Investigation evidential views, Slow Cook substrate, Help & Repair) provided staging uses `ATLAS_ENV=staging` so owner bootstrap is allowed.

This is **not** production-ready and **not** a cutover recommendation.

## Counts

| Classification | Count |
|---|---|
| PRESERVED | 16 |
| IMPROVED | 12 |
| INTENTIONALLY REPLACED | 7 |
| MISSING | 9 |
| REGRESSED | 1 |
| NOT APPLICABLE | 3 |

## Matrix

See [atlas-original-vnext-parity.json](./atlas-original-vnext-parity.json) for the machine-readable rows.

### A. Entry / auth

| Capability | Class | Evidence | Gap |
|---|---|---|---|
| Owner session | PRESERVED | vNext `POST /api/session` bootstrap when not production; httpOnly cookie + CSRF. Original native `/login`. | Staging must **not** set `NODE_ENV`/`ATLAS_ENV=production`. |
| Native password/PIN login UI | REGRESSED | Original `AtlasLogin.tsx` + `/login`. vNext Workbench auto-bootstraps the host owner. | **P2.** Workaround: staging bootstrap. Does not block owner staging. |
| Logout | PRESERVED | `POST /api/session/revoke` + UI sign-out. | |
| Google/OIDC | MISSING | Live original `googleEnabled=false`. Issue #18. | **P3.** Not live on original. |
| Tenant identity | IMPROVED | Server-derived tenant; client `tenantId` is fail-closed. Original mixed nginx/native-auth sidecar. | |
| Ordinary-user tenancy fixture | MISSING | Staging is owner-only by design. | **P3** for this tranche. |

### B. Workbench

| Capability | Class | Evidence | Gap |
|---|---|---|---|
| Primary navigation | PRESERVED | Conversation + dungeon surfaces in `App.tsx`. Original dungeon cards (Investigation/Writing/Music). | **P3** visual difference. |
| Conversations / runs / approvals | PRESERVED | Workbench snapshot, executions, tool approvals. Host tests. | |
| Project switching / restore | PRESERVED | Projects + conversations persist; reload reads server state. | |
| Device-bridge / companion | MISSING | Original companion/relay. Deliberately not ported. | **P3.** Not first-use. |

### C–E. Projects / Files / Conversation

| Capability | Class | Evidence | Gap |
|---|---|---|---|
| Create/open/persist projects | PRESERVED | `platform/projects` + Workbench UI. | |
| Upload / retrieval / provenance | IMPROVED | CAS + Files + provenance vs original SQLite `content_base64`. | |
| Conversation + streaming | PRESERVED | Host SSE + ConversationRuntime. Browser acceptance on mock host 2026-09-17. | |
| Compiled context | IMPROVED | PR #23. LLM receives compiled context, not the whole estate. | |

### F. Providers / models

| Capability | Class | Evidence | Gap |
|---|---|---|---|
| Capability aliases | INTENTIONALLY REPLACED | Original Mountain aliases → Nexus `nexus/fast\|reason\|code\|…`. | Same user job, different names. |
| Routing vs transport | IMPROVED | Nexus WHERE, Execution HOW. | |
| No failover after visible output | IMPROVED | ExecutionBroker contract + tests. Mountain had the rule; vNext also treats reasoning as visible. | |
| Provider allow/deny lists | MISSING | Issue #12. `processing=local_only` and kill switches exist. | **P2.** Accepted post-release in VNEXT-RELEASE-VALIDATION.md. Not a staging login/routing blocker. |

### G–H. Tools / CAS / retrieval

| Capability | Class | Evidence | Gap |
|---|---|---|---|
| Tool invoke + Authority | PRESERVED | Server-side Authority; UI hiding is not a control. | |
| CAS / dedupe / bounded retrieval | IMPROVED | Shared Files/CAS/context. | |
| Embeddings | MISSING | Lexical retrieval is the accepted baseline. | **P3.** |

### I. Caspa / Writing

| Capability | Class | Evidence | Gap |
|---|---|---|---|
| Persistent writing / revisions | PRESERVED | Writing dungeon + documents/versions. CaspaPanel UI. | |
| GoldPipeline / StoryBible product UI | INTENTIONALLY REPLACED | Behaviour restored as outline/canon/claims records, not a Caspa UI clone. | **P2** UX, not substrate. |
| Print/EPUB | MISSING | Original writing dungeon advertised print+EPUB. | **P2.** Does not block staging writing. |

### J. Investigation

| Capability | Class | Evidence | Gap |
|---|---|---|---|
| Evidential substrate + provenance | IMPROVED | A1 ledger. | |
| Chronology / threads / claim-evidence / corroboration / contradiction / gaps / hypothesis | IMPROVED | A2 views + tests. Hypothesis tests cannot become facts. | |
| Caseboard / share-PIN portal | MISSING | Original `/investigation/` + PIN share. | **P2.** Staging uses Workbench Investigation panel. |

### K–L. Local acquisition / Slow Cook

| Capability | Class | Evidence | Gap |
|---|---|---|---|
| Immutable original + hashes + CAS handoff | IMPROVED | PR #22. Caller-supplied bytes only. | |
| Device Control ingest | MISSING | Unimplemented by design. | **P3.** |
| Background Slow Cook + interactive priority | IMPROVED | PR #23 scheduler. | Owner staging can exercise via jobs UI/API. |

### M. Operations / Help & Repair

| Capability | Class | Evidence | Gap |
|---|---|---|---|
| System Doctor + proposed repair + Authority | IMPROVED | Substrate PR #26; this tranche adds `GET /api/ops/doctor`, apply route, Help & Repair nav. Consequential repairs stay `proposed`. | |

### N. Settings / Privacy / Safety

| Capability | Class | Evidence | Gap |
|---|---|---|---|
| Owner Privacy & Safety | PRESERVED | Privacy dungeon, owner-only. | |
| `private_cloud` routing target | MISSING | Issue #19. `local_only` already excludes public cloud. | **P3.** |

### O. Operational quality

| Capability | Class | Evidence | Gap |
|---|---|---|---|
| Postgres + migrations + health | PRESERVED | Production readiness PR #11; `/api/health/live` independent of providers. | |
| SHA/build identity | IMPROVED | `/api/health.identity` + Help & Repair display. | |
| nginx `/v12` / OpenWebUI / preview path regexes | INTENTIONALLY REPLACED | Discarded. Website Studio is a thin dungeon. | |
| God-service Nexus | INTENTIONALLY REPLACED | Split Nexus/Execution/host. | |

### REGRESSED

| Item | Severity | Why | Corrective |
|---|---|---|---|
| Native login page vs one-click owner bootstrap | P2 | Original has a dedicated `/login`. vNext owner staging authenticates by bootstrap, not a password form. | Keep bootstrap for staging. OIDC/#18 is post-release. Do not weaken production bootstrap lock. |

No REGRESSED P0/P1.

## Workload comparison

Equivalent live workloads were **not** run against original production (do not mutate/copy production data). vNext evidence is fixtures/tests + the 2026-09-17 mock-host browser walkthrough in `VNEXT-RELEASE-VALIDATION.md`. Original live evidence this run: `/auth/status` reachable, native login configured, Google off.

## P0 / P1 / P2 / P3

- **P0:** none found.
- **P1:** none on the owner staging workload.
- **P2:** native login UX; Caspa product chrome (GoldPipeline/print); investigation share-PIN; provider allow/deny (#12).
- **P3:** OIDC, device-bridge, embeddings, private_cloud, ordinary-user fixture, Device Control.

## Staging verdict

Private staging is **not blocked**. Owner-only bootstrap + isolated compose is the first-use path.
