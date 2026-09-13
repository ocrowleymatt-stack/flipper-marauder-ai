# Atlas vNext — Storage Model

One content store, one durable relational core, one secret store, one snapshot
story. No domain invents its own persistence. Census grounding: §§9, 13, 21, 24.

---

## 1. Principles

1. **Content-addressed bytes.** Every blob (attachment, artifact, ingest file,
   capture, snapshot payload, site preview bundle, generated media) is stored
   once under the hash of its bytes. Attachments, artifacts and ingest become
   *views* (metadata + links), not separate homes for bytes.
2. **Uniform provenance envelope.** Every stored object links: producer
   (provider/tool/job/plugin + version), source (URL/engine/device or
   derivation chain), retrieved/created-at timestamps, evidential status, and
   the correlation id of the request/job that created it. The claim-ledger and
   assurance/audit ideas graduate from writing/investigation into platform
   properties.
3. **Explicit lifecycle.** Retention, quotas and GC are policy data per
   collection (e.g. site previews are ephemeral with bounded total size — the
   storage-pressure incident must be structurally impossible, not patched).
4. **Durable relational core for state.** Projects, conversations, messages,
   jobs, permissions/grants, traces, ledgers, vault metadata and snapshots'
   manifests live in a relational store with **ordered migrations** (keep the
   35-migration discipline), per-tenant isolation, and single-writer clarity
   per tenant.
5. **Secrets are special.** Vault pattern only: encrypted-at-rest, fingerprint
   metadata, hardened key file **plus tested key escrow and restore** — closing
   the census's sharpest gap (total secret loss on key-file loss).
6. **Snapshots are first-class.** Point-in-time project snapshots (state +
   content manifest) with tested restore; backup covers databases *and* blob
   store *and* escrowed keys, and restore is exercised in CI, not documented
   in a wiki.

## 2. Logical layout

```text
storage/
  blobs/            # content-addressed: <hash> -> bytes (+ codec metadata)
  core relations:
    tenants         # isolation root; all rows tenant-scoped
    projects        # durable project state: settings as typed columns + extension JSON
    conversations   # project-scoped; messages; targets normalized at ingress
    jobs            # durable-job records (see JOBS-AND-EVENTS.md)
    events          # durable event log (job progress, tool outcomes, audit)
    tool_executions # every side-effecting call: intent, decision, result, trace link
    claims          # generalized claim ledger: assertion -> evidence links
    findings        # research/OSINT results with evidential status
    artifacts_meta  # views over blobs: previews, publications, bundles, captures
    attachments_meta# views over blobs: manifests, processing state, OCR/extracts
    traces          # per-turn step ledger (debuggability)
    vault_meta      # secret fingerprints + rotation metadata (ciphertext alongside)
    snapshots       # manifests + pointers for backup/restore/GC
  vault/            # encrypted secrets (Vault pattern + escrow)
  snapshots/        # exported bundles for backup/restore
```

## 3. Content lifecycle (the processing-state machine, generalized)

The attachment processing-state machine (§13) becomes the platform content
lifecycle: `received → validated → stored → indexed/extracted → linked →
retained|expired → collected`. Every transition is an event on the correlation
trace. Format-specific extraction (OCR, binary, media) is a **pipeline of
versioned extractor plugins**, not inline format code.

Quotas and GC: per-collection size/age budgets with watermark events; GC is a
broker job (durable, cancellable, audited), never a cron script or manual
cleanup shell.

## 4. Durable project state

- A project is the durability root: conversations, content views, jobs, claims,
  findings, snapshots and UI state hang off it. Deleting/exporting a project is
  one operation with one audit trail.
- Project settings move from opaque `settings_json` blobs to typed core
  columns for queryable policy (retention, capabilities enabled) + namespaced
  extension JSON for plugin data (plugins read/write only their namespace).
- Guest bundles/publication access (investigation-portal semantics) become
  **capability-scoped read views** over project state with expiry — not cloned
  rows.

## 5. Conversations and messages

- Conversations are project-scoped rows; messages append-only (no in-place
  edits — corrections are new messages, preserving the trace).
- Model targets stored normalized (canonical capability/route ids); the HTTP
  layer never persists raw aliases.
- Retrieval gating (§23) is recorded: each assistant turn links the project
  context snapshot it consulted.

## 6. Vault and key management

- AES-GCM (or equivalent) secrets with fingerprint/rotation metadata; master
  key file permission-hardened as today.
- **New (required):** escrowed key shares with a documented, *tested* restore
  path; rotation procedure; backup verification job that proves (without
  exposing) that escrow + database + blobs restore to a working system.
- Provider credentials resolve through the registry from Vault — never env
  strings past ingress, never plaintext in logs (root redaction preserved).

## 7. Snapshots, backup, restore

- Two snapshot kinds: **project snapshots** (user-facing: freeze/share/restore
  a project) and **system backups** (tenant DB + blob manifest + vault escrow
  pointers).
- Restore is a first-class operation with pre-flight checks (schema
  compatibility via migration versions, quota checks) and dry-run support.
- Recovery drills run in CI against fixture tenants: backup → destroy → restore
  → verify. A backup that has never restored is not a backup.

## 8. Migration discipline (ported)

- Ordered, append-only migrations; single-writer application at boot; every
  migration has a down path or an explicit no-down justification.
- Contract types (`packages/contracts`) version alongside schema: breaking
  shape changes ship with a migration, not a fork.

## 9. What we explicitly do not carry over

- Three parallel content homes with different provenance rules; format-specific
  inline extraction; quota-less preview storage; `settings_json` as the junk
  drawer; per-domain CRUD store idioms; key file without escrow.
