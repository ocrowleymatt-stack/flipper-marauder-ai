# Storage model

## Goal

Store files, revisions and artefacts without cloning working trees. Identical bytes are stored once. History is a graph of manifests, not copies.

## Objects

```text
Blob
  digest        sha256:<hex>     identity
  sizeBytes
  mediaType     optional hint (not authoritative)
  createdAt

Manifest                       a directory or composite object
  schemaVersion
  id            ObjectId (type: file | artefact | snapshot | …)
  projectId
  blobDigest?                  if this object is a single file
  entries[]                    { name, digest | manifestId, mode }
  parents[]                    previous manifest ids (history)
  createdAt
  provenanceId?

ObjectRef                      mutable name
  projectId
  path                         project-relative (e.g. "manuscript/ch-01.md")
  manifestId                   current tip
  updatedAt
```

A **revision** is a new manifest. It may reuse 99% of prior blob digests. Checkouts materialise blobs into a workspace; they are caches, not sources of truth.

## Authoritative vs derived

| Authoritative | Derived / cache |
|---|---|
| Blob store (digest → bytes) | Workspace working tree |
| Manifests + ObjectRefs | Search index |
| Project records | Conversation attachments view |
| Provenance records | UI thumbnails |

Conversation “uploads” create blobs + manifests and attach an ObjectRef to the project (and optionally a conversation object). They must not exist only as `content_base64` rows.

## Deduplication

`put(bytes)` hashes first. If `sha256` exists, return the existing blob id. No second copy.

Investigation captures in Atlas Mountain already store `capture_sha256` and reuse it across versions when bytes match (`investigation-local-sources.test.ts`). That behaviour is the oracle; the implementation was per-table, not a platform store.

## Project layout (logical)

```text
project/<id>/
  refs/            ObjectRefs (tips)
  manifests/       Manifest documents
  jobs/            Job records (or pointer to jobs store)
  conversations/   Conversation objects (not files)
```

Physical layout is an implementation detail. Phase 1 does not pick filesystem vs SQLite vs object storage; the **API** is digest-addressed.

## Failure modes

- **Digest mismatch on read:** treat as corruption; do not return bytes. Restore from backup.
- **Partial write:** blobs are written to a temp name and renamed onto `sha256/ab/cd/<hex>`. A crash leaves temp garbage, never a wrong digest.
- **Path traversal:** ObjectRef paths are relative, no `..`, no absolute paths (`path-safety.ts` behaviour).
- **ZIP ingest:** bounded members, expansion ratio, no traversal (keep Atlas Mountain rules).
- **Tenant isolation:** blob keys are prefixed by tenant id. Guests cannot compute another tenant’s digest path even if they know the hash.

## Migrations

`schemaVersion` on manifests starts at `1`. Adding fields is backward compatible if readers ignore unknowns. Renaming or changing digest algorithm requires a migration that rewrites manifests (blobs stay).

## What we refuse from Atlas Mountain

- Unique index on `artifacts.relative_path` as identity.
- Base64 columns as the blob store.
- Conversation-owned binary that is later “materialised” into a workspace as a side effect.

Those can remain *import adapters* during migration (see `docs/MIGRATION-PLAN.md`).
