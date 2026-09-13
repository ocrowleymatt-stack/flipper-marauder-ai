# Atlas vNext — Capability Census

This census records **behaviour**, not the current file tree. Atlas Mountain
was **not checked out in this environment**. Where Mountain behaviour is
described, the source is called out: Caspa’s co-resident deploy unit, a
prior local census on branch `cursor/atlas-vnext-census-arch-e2ed`, and
extracted libraries in `ocrowley-commons`.

Legend:

| Verdict | Meaning |
|---|---|
| **Port** | Behaviour is sound; re-implement behind the new boundary |
| **Redesign** | Need is real; current shape fights vNext boundaries |
| **Merge** | Duplicate implementations; one owner in vNext |
| **Discard** | Accidental complexity, forks, folklore, or legal risk |

---

## 1. Repos audited and how they were treated

| Repository | Access in this run | Treatment |
|---|---|---|
| `ocrowleymatt-stack/flipper-marauder-ai` | Writable workspace (`/workspace`) | **Target.** Greenfield Atlas vNext. GitHub description still describes the original Flipper/Marauder product. History on `main` is a single init commit. |
| `ocrowleymatt-stack/atlas-mountain` | **Not present.** `gh` cannot resolve the repo with this token. Caspa ships `deployment/atlas-mountain-oidc/` including `atlas-mountain-nexus.service`. | **Reference only (indirect).** Do not clone into this repo. Do not copy. |
| `ocrowleymatt-stack/Caspa` | Public clone at `/tmp/ref-repos/caspa` | **Reference.** Literary OS, jobs, failover, Nexus recovery consumer, identity, doctor/ops, picture-book / prize / export engines. |
| `ocrowleymatt-stack/ocrowley-commons` | Public clone | **Reference.** Extracted kernels: AI client, jobs/SSE, policy, hash-chained audit, OSINT, darkweb, persistence, research honesty, Life-os Python cores. **This is the most important out-of-Mountain catalogue.** |
| `ocrowleymatt-stack/Life-os` | Public clone | **Reference.** Daedalus HITL factory: planner → builder → tester → Aegis/Iris/Reviewer/Themis. Morpheus memory, Mnemosyne orchestrator. |
| `ocrowleymatt-stack/Shakespeare-` | Public clone | **Reference.** Sibling literary app; source of local-first persistence patterns extracted into commons. |
| `ocrowleymatt-stack/craigs-navigator` | Public clone | **Reference.** Privacy-first companion; evidence-first reasoning; share-sensitivity. |
| `ocrowleymatt-stack/TheBigBrother` | Public clone (forked OSINT HUD) | **Reference registry only.** Do not vendor scanner engines. |
| `ocrowleymatt-stack/handsy-ios` | Public clone | **Discard for vNext.** Capacitor stub / intercept aspiration; legal and App Store risk. |
| `ocrowleymatt-stack/handy-ios` | Listed; empty-ish | **Discard.** |
| Private repos named by commons extraction map (`nexus-backend`, `spiderfoot-ui`, `Hook`, `novel-machine`, `Mn-Infrustructure`, `Nexus`, `NexusPlexus`, `subatomic`, `anon-kb-app`, `mnemosyne-demo`, `Echo-clip-engine`, `ocrowley-evidence-portal`, `flipper`, …) | Token cannot view them | **Indirect reference** via `docs/EXTRACTION_MAP.md` and extracted packages. |

Original prompt sources found:

1. This design-gate task (first-class).
2. `flipper-marauder-ai` `README.md` (init commit): census, durable jobs/projects, events, CAS, provenance, capabilities, thin Nexus + broker, plugin Dungeons, built-in observability/eval/backup/transactional deploy.
3. Prior branch `cursor/atlas-vnext-census-arch-e2ed` (docs + 12 Nexus contract cases). Used as a **lead**, not copied wholesale. That branch assumed a local `atlas-mountain` checkout which this environment does not have.

---

## 2. Important capabilities found **outside** atlas-mountain

These are the highest-leverage findings. They would be missed by an
Atlas-Mountain-only audit.

### 2.1 Flipper Zero / Marauder product (this repository’s GitHub identity)

**Behaviour.** A web app that talks to a Flipper Zero running Marauder
firmware over **Bluetooth BLE UART or USB Serial**, with an AI assistant
that accepts **voice and text**, executes Marauder commands with
step-by-step guidance, and checks firmware updates. Built with Manus.
Created 2026-06-05; the vNext init commit on 2026-09-13 replaced the
tree with a README.

**Why it matters.** Device control in Mountain is “companion + relay +
Atlas OS”. Flipper/Marauder is a **concrete RF/serial device domain**
with firmware lifecycle, not a generic local-control script. vNext must
reserve a **Device / Marauder dungeon** and a broker-mediated serial/BLE
tool surface. Do not bury this under “local-control”.

**Verdict: Redesign** as `dungeons/device-marauder` over the device-relay
contract. **Discard** any ambient browser-serial access that bypasses
the broker and capabilities.

### 2.2 Caspa — literary OS and first Nexus consumer

Caspa is a single Express + React process (port 3000) that is a full
writing product, not a Mountain dungeon:

- **Doors:** Just write · Picture book · Polish; engines for plot hold,
  prize draft, design studio, publish pack, illustrated books, gold
  pipeline, quality gates, story bible, promise registry, psychology.
- **Durable jobs:** JSON-backed queue that survives restarts, idempotency
  keys, checkpoints, archive of large results, SHA-256 manuscript
  checksum provenance (`jobProvenance.ts`).
- **Hybrid persistence:** browser `localStorage` (local-first drafts),
  filesystem job store, PostgreSQL `CASPA_DATABASE_URL` for canonical
  projects/revisions in production.
- **Router failover:** Unified Router (`:9999` OpenAI-compatible) first
  when configured; Ollama hunt; cloud chain; **billing/quota as a routing
  signal**; longer cooldown for billing than transient errors; web-search
  capability is a real provider property, not a prompt claim.
- **Nexus recovery fabric client:** loopback
  `http://127.0.0.1:43101/internal/recovery/incidents`. Classify, at most
  one bounded retry, never let recovery outage become a second outage.
  This is documented as the **first cross-service consumer** of the
  fabric.
- **Identity:** Authentik UID/groups via nginx; shared proxy secret;
  fail-closed header policy (`nginxIdentityPolicy.ts` — client-supplied
  identity headers stripped). Native Atlas accounts noted as production
  human-auth on the Mountain unit.
- **Doctor/ops:** public `/api/doctor` sanitised; authenticated
  `/api/v2/doctor` for fingerprint. No secrets in reports.
- **Deploy:** Hetzner + PM2 + nginx; GitHub Action with SSH;
  smoke scripts; transactional “verify then reload”.

**Verdict:** Port job idempotency, checksum provenance, billing-as-routing,
recovery-client contract, fail-closed identity, doctor split. Redesign
Caspa as a **versioned consumer** of vNext, not an in-tree god-app.
Discard Firebase/Firestore dual-write paths and nested AI Studio dumps.

### 2.3 ocrowley-commons — already-extracted platform kernels

This repo is a deliberate extraction from Caspa, Shakespeare, Life-os,
craigs-navigator, nexus-backend, spiderfoot-ui, Hook, novel-machine, and
Mn-Infrustructure. Behaviour worth treating as vNext *specs*:

| Package | Behaviour |
|---|---|
| `@ocrowley/ai-client` | Ollama-first multi-provider client |
| `@ocrowley/jobs` | File-backed jobs + SSE broadcaster |
| `@ocrowley/intent` | Input/action/output contracts; plan ≠ write |
| `@ocrowley/persistence` | Atomic file writes, local-first |
| `@ocrowley/policy` | Allow/deny engine, default deny, production write gates |
| `@ocrowley/audit` | Hash-chained tamper-evident ledger |
| `@ocrowley/osint` | `who()` people lookup, dossiers, default-deny case auth, async jobs + SSE, hash-chained WHO audit |
| `@ocrowley/darkweb` | Clearnet Ahmia + keyed breach adapters; no Tor client in-process |
| `@ocrowley/research` | Honest search: `web_search_unavailable` instead of fabricated hits |
| `@ocrowley/quality` | Deterministic gold/AI-smell gates |
| `@ocrowley/crypto` | AES-256-GCM + HMAC |
| `@ocrowley/ops` | Doctor helpers, no secrets |
| Python `ocrowley_memory` | Morpheus TTL memory |
| Python `ocrowley_agents` | Mnemosyne registry, dispatcher, DLQ, snapshots |
| Python `ocrowley_policy` / `ocrowley_planner` / `ocrowley_operator` | HITL factory; execute disabled by design |
| Python `ocrowley_contracts` | Builder/tester/Aegis/Iris/Reviewer as Protocols |

**Verdict: Port as behaviour/spec** into vNext contracts (do not npm-depend
on commons from Nexus). **Discard** embedding commons as a secret
backdoor around the broker.

### 2.4 Life-os / Daedalus — HITL software factory

Issue → planner → builder → tester → Aegis (security) → Iris (architecture)
→ Reviewer → Themis (approval). **No autonomous merge. No production
deploy.** Risk tiers GREEN→CRITICAL. No-go: secrets, prod deploy, auth
logic, destructive DB, user data, external messaging.

**Verdict: Redesign** as platform evaluation + change-control jobs, not
a second orchestrator inside Nexus. Themis-style human gates map to
capability suspension.

### 2.5 OSINT / intel cluster (via commons, not Mountain tree)

- `who()` full toolkit with case-scoped default deny.
- Dossier/scan types from spiderfoot-ui.
- Dedup, persona/stylometry, deception patterns, geospatial cluster,
  Wayback CDX from nexus-backend.
- Dark-web **clearnet index only**.
- TheBigBrother: 21-module registry / bridge, **not vendored**.
- Evidence-first guardrails from Hook + craigs-navigator.

**Verdict: Port** federation, default-deny case, honest unavailability,
evidential envelope. **Discard** CLI shell-outs as default library
behaviour; keep as optional broker tools behind capabilities.

### 2.6 Unified Router and owned inference edge

Caspa prefers `UNIFIED_ROUTER_URL` (`127.0.0.1:9999` or Docker
`172.18.0.1:9999`) as an OpenAI-compatible `/api/chat/completions`
front. Mountain’s systemd unit shows owned Power Pod + SearxNG on
loopback, Quantum/Compute/Music/Playwright as **non-fatal** ExecStartPre
so specialist install cannot take Nexus down.

**Verdict: Redesign** Unified Router / Forge / Hetzner / RunPod as
ordinary broker adapters with registry priority “owned first”. The
non-fatal specialist install policy is a **deploy invariant** to keep.

### 2.7 Privacy companion and local-first writing

Shakespeare and craigs-navigator prove local-first persistence, consent
for share, and “enhanced audio is probabilistic”. **Port** the honesty
contracts. **Discard** diagnostic claims.

### 2.8 Identity and tenancy outside Mountain source

Caspa production: Authentik + nginx proxy secret + ops groups.
Commons policy: role-gated production writes (this is **role-based** and
must be **redesigned** into capability issuance at the edge).
Mountain unit: `NEXUS_NATIVE_AUTH_ENABLED=true`, break-glass must not be
the normal path.

### 2.9 What the private-repo map claims exists but we could not clone

novel-machine coherence libraries; Mn tamper ledger (present in
commons); Hook evidence product; spiderfoot-ui product shell; Nexus UI
graph/search; anon-kb vault; mnemosyne-demo capability registry;
Echo-clip Themis nest; a separate `flipper` repo. Treat as **backlog
references**, not blockers for this gate.

---

## 3. Atlas Mountain behaviour (indirect census)

The prior local census (`5cc7a96` on Mountain `main`) plus Caspa’s
`atlas-mountain-nexus.service` describe a large Nexus process that
already mixes routing, providers, dungeons, jobs, auth, and deploy.
vNext exists because that mix is the problem. Summary of behaviour to
learn from (not copy):

### Product surfaces

- Desktop Vite shell (chat, models, projects, dungeons, permissions,
  portal, activity, attachments, auth) + PWA/Capacitor.
- HTTP/SSE API on loopback; mobile gateway on a separate port (43102)
  with pairing cookies.
- Recovery fabric on 43101 (Caspa client confirms).
- Playwright MCP on 43103.
- CLI/scripts: companion, ingest, deploy, RunPod brokers.
- Plugin “Dungeons”: writing, investigation, website studio, music,
  quantum, plus skills (`SKILL.md` + `skill.json`).
- Device: local-control relay, Atlas OS Android modules (voice, safety,
  vault, location).

### Domain modules (today: in-process, not isolated)

Writing commissions, claim ledger, factuality gate, evidence library,
publication lock; Investigation runs/caseboard/assurance/snapshots;
Research jobs + federated search (Brave/Kagi/Exa/SearxNG + RRF);
Website Studio preview served by Nexus; Music DSP; Quantum simulator +
Qiskit; Compute fabric (shared, not dungeon-owned — keep this invariant).

### Job / project / workflow

Three parallel job systems (research poll loop, investigation
run-recovery, writing headless worker) plus device job-store and compute
workers. Projects with `settings_json`. This is the primary merge target.

### Storage / artifacts / caching

Attachments, artifacts, ingest workspaces — three homes. Attachment
provenance and processing-state machine are the right instinct. Storage
pressure on Website Studio shows missing global quota/GC. Vault:
AES-GCM secrets, file-permission master key, **no escrow story**.

### Eventing / progress / streaming

SSE for chat; in-memory abort maps; no durable event log. Caspa/commons
SSE job broadcaster is a better starting spec than Mountain polling.

### Auth / permissions / tenancy

Native Atlas accounts; tenancy database router (per-tenant SQLite);
guest denylists; permission engine + pending-permissions **suspension**;
posture/persona mixed into prompts. Scattered enforcement.

### Provenance / audit / reproducibility

Writing claim ledger; investigation assurance; attachment provenance;
quantum compiled provenance; Caspa SHA-256 job checksums; commons
hash-chained audit. All should become **one envelope + one ledger**.

### Routing / Nexus

Capability table (`instant|reason|code|research|deep|adversarial|private|frontier|vision|experimental`),
keyword auto-router, workspace auto-router, hybrid Power-Pod-first
policy, multimodel scout+lead. Fat router: cooldowns, performance
ranking, failover all live together. **Integrity gap:** `hetzner/chat`
and generic `runpod` cited as primaries without adapters in
`configureProviders`.

### Execution / workers / sandboxes

FailoverProvider with transactional tool-call buffering;
immune-system tool retry; 60+ tools in one registry; filesystem sandbox
root; MCP discovery; Python/shell tools; RunPod compute governor;
headless writers.

### External integrations

OpenAI (Responses), Anthropic, Gemini, Venice, OpenRouter, xAI/Grok
(inconsistent shape), Ollama, RunPod, Hetzner/Forge, SearxNG,
SpiderFoot, Brave/Kagi/Exa, IBM Quantum, Authentik/OIDC debris,
Playwright.

### Tests / CI / packaging

~130 Nexus tests + desktop vitest + deploy pytest. **The test cases are
the treasure.** Contract-check shell scripts are not CI gates.

---

## 4. Behaviour worth keeping (census distilled)

Correctness properties to preserve **as tests**, not as files:

1. Transactional tool-call buffering; no failover after visible text.
2. Billing/quota is a routing signal (Caspa; stronger than Mountain docs).
3. Local-only capability is a registry filter, not a prompt.
4. Human permission suspension waits; it does not auto-allow.
5. Recovery fabric unavailability ≠ second outage.
6. Logger-root secret redaction.
7. Project-scoped retrieval gating before answer.
8. Vault encrypted-at-rest; fingerprints, not plaintext keys in DB.
9. Honest search unavailability (`web_search_unavailable`).
10. Default-deny OSINT case auth.
11. Hash-chained audit verify().
12. Fail-closed identity headers at the edge.
13. Specialist runtimes must not take the general assistant offline.
14. Compute fabric is platform, not dungeon-owned.
15. Job idempotency keys + restart-safe stores (Caspa).
16. Public doctor is sanitised; detailed doctor is gated.
17. Plan ≠ write (intent contracts).
18. Themis: no autonomous production merge.
19. Device safety actions that work without network (Atlas OS).
20. Skill format: versioned markdown + JSON manifest.

---

## 5. Accidental complexity to discard

- Fat Nexus (routing + failover + dungeons + jobs + preview HTTP).
- Three job systems, three content stores, three telemetry paths.
- CSS skin accretion and `*Ultimate` UI forks.
- Companion script duplication of relay logic.
- Install-script sprawl and string-match repair policies.
- Unregistered route primaries / silent vendor substitution.
- Role checks at the execution boundary.
- Firebase dual persistence in Caspa.
- Vendoring TheBigBrother scanners or handsy intercept stubs.
- Bulk-copy of Atlas Mountain or Caspa into this repo.
- Polling clients where events exist.
- Ambient `settings_json` junk drawers.
- Break-glass as a normal deploy path.
- Hardcoded API keys (commons already scrubbed a nexus-backend incident).
