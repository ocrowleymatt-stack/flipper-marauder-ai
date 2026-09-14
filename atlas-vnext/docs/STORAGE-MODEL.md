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
```

On disk this is `<casRoot>/sha256/<aa>/<bb>/<hash>`. Metadata lives in PostgreSQL (`cas_objects`, `cas_refs`, `files`), not beside the blob directory as a second source of truth.

## Metadata

`workspaces` / projects — id, name, dungeon, `root_manifest_hash`, revision, timestamps.  
`cas_objects` — sha256, size, created_at.  
`cas_refs` — tenant-owned references (file, artefact, extraction).  
`files` / `file_versions` — logical path, mime, size, content hash, version.  
`artefact_metadata` — id, project/workspace, job, blob hash, type, version lineage.  
`chunks` — bounded retrieval text + locators (not uploaded file bytes).

## Manifest

Deterministic JSON: sorted paths, sha256, sizeBytes, mimeType, executable. The manifest file is itself hashed.

## GC

Reference-count from `cas_refs`; `gcUnreferenced` unlinks orphans. Logical file delete does not immediately unlink shared blobs.

This PR ships the filesystem CAS adapter, metadata schema, and GC hook.
