# ADR 0002 — Content-addressed storage as the only blob boundary

## Status

Accepted (design gate).

## Context

Mountain stores attachments, artifacts, ingest workspaces, site
previews, and snapshots in separate homes with inconsistent provenance.
Caspa stores jobs on disk and manuscripts with SHA-256 checksums after
the fact. Website Studio has already hit storage-pressure incidents
without global GC.

Path-based APIs invite dungeon-specific folders and make sharing,
dedup, and restore drills harder.

## Decision

1. All bytes enter the system through `put(bytes, provenance) → cas:sha256:<hex>`.
2. Projects **link** addresses with a role (`attachment`, `artifact`,
   `checkpoint`, `preview`, `ingest`, `export`).
3. Job checkpoints are content addresses, not opaque row blobs.
4. Preview serving is a read of a linked CAS object plus a retention
   policy job — not a second filesystem root owned by Website Studio.
5. Architecture tests fail if public storage types accept a raw path
   as a locator.

## Consequences

- Dedup and integrity are free.
- Provenance is mandatory at write time.
- Migration from legacy stores becomes a linker job, not a format fork.
- Small inline text (chat messages under a size cap) may travel in
  events without CAS; crossing the cap requires a put.
