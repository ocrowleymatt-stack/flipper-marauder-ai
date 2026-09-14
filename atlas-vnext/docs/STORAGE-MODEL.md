# Storage model

## Rules

1. Content-addressed blobs (SHA-256). Immutable after write.
2. Dedup across projects and revisions.
3. Directories and revisions are manifests (hash lists), not copied trees.
4. **PostgreSQL** stores metadata and hashes only. **No `content_base64`. No file bytes in relational rows.**
5. Project namespaces isolate quota accounting; blobs may still dedup globally by hash.
6. Quotas, retention, and GC are platform policies, not dungeon code.
7. Transactional metadata (manifest pointer + artefact row) commits in one PostgreSQL transaction; the blob must already exist in CAS.

## Why PostgreSQL

Caspa’s `hybridCoreRepository` already uses PostgreSQL for immutable manuscript versions and optimistic concurrency. Jobs, grants, and the transactional outbox need ACID and boring backups (`pg_dump` + WAL). SQLite is allowed as a **dev stand-in with the same schema**, not as a second production database. See [BORING-CORE.md](./BORING-CORE.md) and [BACKUP-AND-RECOVERY.md](./BACKUP-AND-RECOVERY.md).

## Target layout

```text
storage/
  blobs/sha256/ab/cd/<hex>
  manifests/sha256/ab/<hex>.json
```

Metadata lives in PostgreSQL, not beside the blob directory as a second source of truth.

## Metadata (illustrative)

`projects` — id, name, dungeon, `root_manifest_hash`, settings, timestamps.  
`blobs` — sha256, size, mime, extracted_text (truncated), refcounts.  
`manifests` — sha256, project_id, parent, entries_json (or entries as rows).  
`artefacts` — id, project_id, job_id, blob_hash, provenance_json.

## Manifest

Deterministic JSON: sorted paths, sha256, sizeBytes, mimeType, executable. The manifest file is itself hashed.

## GC

Reference-count from manifests + artefacts; mark-and-sweep orphans older than retention. Quota watermarks prune disposable preview caches first. Production artefacts and custom-domain sites are protected.

This PR ships the contract and `platform/storage` interface only.
