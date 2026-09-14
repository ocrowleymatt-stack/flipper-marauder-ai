# @atlas-vnext/storage

Platform primitive: content-addressed blob store + versioned manifests.

Blobs are immutable SHA-256 objects. PostgreSQL stores metadata and hashes only — never file bytes or base64 payloads. SQLite may be used as a local/dev stand-in with the same schema.

This package is a design-gate shell. A filesystem CAS is not implemented in this PR.
