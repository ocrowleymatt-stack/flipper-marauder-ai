# @atlas-vnext/storage

Platform primitive: content-addressed blob store + versioned manifests.

Blobs are immutable SHA-256 objects at `sha256/<aa>/<bb>/<hash>`. PostgreSQL stores metadata, hashes, and refcounts only — never file bytes or base64 payloads.

Adapters: `FilesystemCas` (atomic tmp+rename, hash verify, dedup) and `MemoryCas` for tests. GC is a hook: `unlink` only after `cas_refs` reach zero.

See [docs/FILES-AND-CONTEXT.md](../../docs/FILES-AND-CONTEXT.md) and [docs/STORAGE-MODEL.md](../../docs/STORAGE-MODEL.md).
