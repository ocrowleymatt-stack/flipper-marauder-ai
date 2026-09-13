# Storage model

## Rules

1. Content-addressed blobs (SHA-256). Immutable after write.
2. Dedup across projects and revisions.
3. Directories and revisions are manifests (hash lists), not copied trees.
4. Relational DBs store metadata and hashes only. **No `content_base64`. No file bytes in SQLite.**

## Target layout

```text
storage/
  blobs/sha256/ab/cd/<hex>
  manifests/sha256/ab/<hex>.json
  db/atlas_metadata.db
```

## Metadata (illustrative)

`projects` — id, name, dungeon, `root_manifest_hash`, settings, timestamps.  
`blobs` — sha256, size, mime, extracted_text (truncated), refcounts.  
`manifests` — sha256, project_id, parent, entries_json.  
`artefacts` — id, project_id, job_id, blob_hash, provenance_json.

## Manifest

Deterministic JSON: sorted paths, sha256, sizeBytes, mimeType, executable. The manifest file is itself hashed.

## GC

Reference-count from manifests + artefacts; mark-and-sweep orphans older than retention. Quota watermarks prune disposable preview caches first.

This PR ships the contract and `platform/storage` interface only.
