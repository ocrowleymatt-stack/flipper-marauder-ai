# @atlas-vnext/storage

Platform primitive: content-addressed blob store + versioned manifests.

Blobs are immutable SHA-256 objects. SQLite (or any relational index) stores metadata and hashes only — never file bytes or base64 payloads.

This package is a design-gate shell. A filesystem CAS is not implemented in this PR.
