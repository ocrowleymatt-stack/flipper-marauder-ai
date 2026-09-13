# ADR 0005 — Isolated domain modules (Dungeons) with import law

## Status

Accepted (design gate).

## Context

Mountain dungeons live in-process with a 68-line plugin contract that
most tools bypass. Investigation alone accrued a dozen migrations and
fifteen tool modules. Writing owns a headless worker. Compute fabric
docs already say GPU is **not** dungeon-owned — the exception that
proves the rule.

Outside Mountain, Caspa, OSINT `who()`, Flipper/Marauder, and Life-os
are whole products. Copying them into Nexus would recreate the blob.

## Decision

1. Each dungeon is a workspace package that implements `DungeonPlugin`
   from `@atlas-vnext/plugin-sdk`.
2. Legal imports: `contracts`, `plugin-sdk`. Nothing else.
3. Dungeons cannot import other dungeons. Cross-domain work is a job
   the broker routes.
4. Flipper/Marauder is a first-class dungeon (`device-marauder`), not
   a script under local-control.
5. Caspa stays a separate consumer.
6. Architecture tests parse imports and `package.json` dependency
   graphs on every CI run.
7. Compute, storage, identity, deploy, eval, and backup are **not**
   dungeons.

## Consequences

- Investigation can stress-test the contract in a later gate without
  rewriting Nexus.
- Teams can fail CI by “just importing writing from investigation”.
- Python specialists (qiskit, music DSP) are broker workers behind the
  same plugin job types.
