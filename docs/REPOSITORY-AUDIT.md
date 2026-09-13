# Repository inventory and capability audit

Audit date: 2026-09-13. All reference checkouts were read-only. No source was
copied into vNext; findings describe behaviour and test ideas only.

## Workspace inventory

`/workspace` contained exactly one Git repository:

| Repository | Role | Audited ref |
|---|---|---|
| `ocrowleymatt-stack/flipper-marauder-ai` | **Only writable target; Atlas vNext greenfield** | base `99bab5b` |

There were no local `atlas-mountain` or other reference repositories under
`/workspace`. The target had only `README.md` on its base branch and no
repository-local agent instructions or pull-request template.

## Reference inventory and access

The GitHub owner exposed nine repositories. Each was inventoried; non-empty
repositories were inspected from a temporary read-only checkout:

| Repository | Audited ref | Atlas relevance |
|---|---|---|
| `ocrowleymatt-stack/Caspa` | `55ea40911eee5e62d568f0e22f9c74fab1279229` | writing product, jobs, recovery, provider routing |
| `ocrowleymatt-stack/ocrowley-commons` | `6180d7f0d51d16e78c85d3cfdb34f740edbd960c` | shared contracts, jobs, persistence, policy, audit, crypto, OSINT |
| `ocrowleymatt-stack/Shakespeare-` | `f44a746e8acb53be18e7a1a2d8ca0e6cb374d790` | earlier local-first writing product and export behaviour |
| `ocrowleymatt-stack/Life-os` | `b62f30653c2aa206763ab5aeea3e3735b5f5e86f` | controlled agent workflow, risk and approval gates |
| `ocrowleymatt-stack/craigs-navigator` | `d860153fc61b274a19ebf97a5a48869b6afa1074` | privacy-first companion and consent UX |
| `ocrowleymatt-stack/TheBigBrother` | `3e9569acead32efec755b0baae83922fa05ec5a1` | OSINT module catalogue and fan-out behaviour |
| `ocrowleymatt-stack/handsy-ios` | `96ac8cf812d8098a9e4277814b69214e4c0ffd12` | Capacitor/native bridge scaffold |
| `ocrowleymatt-stack/handy-ios` | empty repository | no capability |
| `ocrowleymatt-stack/flipper-marauder-ai` | `99bab5b` | greenfield target, not a legacy capability source |

`ocrowleymatt-stack/atlas-mountain` was not reachable from this run
(`Repository not found`). The detailed census in `CAPABILITY-CENSUS.md` was
retained from a prior read-only local audit of `atlas-mountain/main` at
`5cc7a96`; this access limitation is recorded instead of pretending the live
repository was re-read.

## Important capabilities outside Atlas Mountain

### Caspa

- **Checkpointed, resumable commissions:** `src/services/serverCommissionJobService.ts`
  checkpoints chapter progress, resumes persisted work, preserves partial
  manuscripts under a QA hold, and gates publication on factual/duplication
  checks. Preserve the behavioural cases; redesign onto the single job/event
  substrate.
- **Useful provenance seed:** `src/services/jobProvenance.ts` records title,
  source brief, word count, excerpt, and SHA-256 result checksum. Generalize to
  the platform provenance envelope; a checksum alone is not a source chain.
- **Nexus recovery consumer:** `src/services/nexusRecovery.ts` reports typed
  incidents and degrades safely when recovery telemetry is unavailable. This
  proves cross-repository recovery contracts are useful, but retries belong in
  the broker rather than each app.
- **Publication-quality controls:** commission code distinguishes factual,
  legal, and high-stakes claims, rejects placeholders and unsupported precise
  guidance, and retains failed output for repair. Port these as Writing domain
  acceptance cases, not shared router logic.
- **Operational lesson:** a monolithic Express/React app and a large repair/
  workflow collection demonstrate why vNext needs isolated domains and one
  transactional deploy path.

### ocrowley-commons

- **Lease-based durable work:** `packages/jobs/src/CaspaJobService.ts` includes
  job stages, partial results, lease ownership/expiry, heartbeats, stuck-job
  recovery, cancellation, and retry. Redesign its file-backed records as the
  durable broker substrate while retaining these cases.
- **Atomic local persistence:** `packages/persistence/src/fileStore.ts` writes
  JSON through temp-file rename. Port the atomic-write property for local
  adapters; do not use file-per-record storage as the platform database.
- **Default-deny capability policy:** `packages/policy/src/index.ts` combines
  capability context, prioritized deny-over-allow rules, and explicit reasons.
  Redesign as capability grants at the broker choke point.
- **Tamper-evident audit:** `packages/audit/src/index.ts` uses stable encoding,
  sequence numbers, previous hashes, and verification. Port the append-only
  hash-chain behaviour into durable audit events.
- **Authenticated encryption:** `packages/crypto/src/encryption.ts` provides
  AES-256-GCM and constant-time HMAC verification. Reuse the behaviour behind
  the Vault boundary, adding key rotation, escrow, and restore drills.
- **Case-scoped, default-deny OSINT:** `packages/osint` requires operator/case
  authorization, archives lookups, supports bridge fan-out, and exposes job
  progress. Port authorization and evidential cases into an OSINT plugin.
- **Honest degradation:** its research architecture explicitly returns
  `web_search_unavailable` rather than fabricating results. Make this a
  platform-wide provider/tool contract.

### Life-os

- **Risk-driven approval chains:** `daedalus/themis/approval_gate_v1.py`
  models pending/approved/rejected/escalated/blocked states, named gates,
  signatures, no-go violations, and decision history.
- **Independent architecture/security gates:** Iris and Aegis separate
  boundary review from security review. Port the gate concepts into CI and
  broker permission suspension; discard the mocked software-factory flow.
- **Decision memory:** structured reports and history demonstrate that
  approvals must be durable events, not transient UI state.

### TheBigBrother and commons OSINT

- **Target-classified parallel fan-out:** `modules/ai_analyst.py` classifies
  email/domain/IP/username, runs relevant modules concurrently, contains
  per-module failures, and synthesizes a result.
- **Broad adapter catalogue:** domain/DNS/TLS, email posture, code-hosting,
  archives, paste search, reputation, network, crypto, EXIF, geo, and aircraft
  feeds identify useful future plugin families.
- **Do not vendor scanner engines:** claims and risk scores are heuristic, raw
  results lack the required uniform provenance, and several functions are
  dual-use/high-risk. `ocrowley-commons` independently marks these engines
  “never vendor.” Preserve only authorized-use test cases and adapter ideas,
  under case-scoped capabilities and evidence envelopes.

### Shakespeare-

- **Local-first project behaviour:** `src/lib/localStore.ts` offers offline
  project CRUD and collection indexing. Preserve offline/restore user cases,
  redesign on durable project storage.
- **Publication export:** `src/lib/epubExport.ts` creates EPUB3 structure,
  ordered chapters, metadata, cover handling, and navigation. Port as a
  capability-gated Writing export tool after the platform substrates exist.
- The duplicated application shell and literary components are discarded in
  favour of Caspa-derived domain cases and the shared thin shell.

### Craig's Navigator

- **Consent by data category:** sharing defaults distinguish low/medium/high
  sensitivity and leave audio, transcripts, and notes opt-in.
- **Evidence-first, non-diagnostic posture:** raw recordings remain available
  beside probabilistic enhancement and the product refuses clinical certainty.
  Port these as permission/provenance requirements for future companion or
  device plugins.

### handsy-ios / handy-ios

- `handsy-ios` is a minimal Capacitor native bridge; its call-recorder methods
  only return status and do not implement recording. Keep only the lesson that
  native capabilities must be advertised explicitly and permission-gated.
- `handy-ios` is empty. Discard both as implementation sources.

## Audit conclusion

The strongest non-Mountain material is not another architecture to copy. It is
a set of behavioural properties: leased resumable jobs, durable approval
chains, tamper-evident decisions, default-deny authorization, honest
degradation, publication QA holds, result checksums, atomic local writes, and
privacy-sensitive sharing defaults. vNext assigns each property to one clean
owner and rejects the duplicate app shells, stores, routers, and repair paths.
