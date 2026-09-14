# @atlas-vnext/storage

Platform primitive: content-addressed blob store + versioned manifests.

Blobs are immutable SHA-256 objects at `sha256/<aa>/<bb>/<hash>`. PostgreSQL stores metadata, hashes, and refcounts only — never file bytes or base64 payloads.

Adapters: `FilesystemCas` (atomic tmp+rename, hash verify, dedup, ENOSPC fail-closed) and `MemoryCas` for tests. Retention of generated site revisions is a product policy (`storage.retain`). GC is a durable job (`storage.gc`) plus a reference-safe unlink hook: never delete while `cas_refs` remain.

See [docs/FILES-AND-CONTEXT.md](../../docs/FILES-AND-CONTEXT.md) and [docs/STORAGE-MODEL.md](../../docs/STORAGE-MODEL.md).
