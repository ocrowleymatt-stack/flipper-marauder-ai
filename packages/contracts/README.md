# @atlas/contracts

Runtime schemas (zod 4) and inferred TypeScript types for the universal Atlas primitives.
Every other package speaks in these types; this package depends on **nothing else in the
repository** (enforced by `npm run boundaries`).

## Single responsibility

Define, validate and version the shapes that cross package boundaries or get persisted.

## Must NOT contain

- behaviour: no routing, storage, job execution, I/O or provider clients
- imports of any `@atlas/*` package
- dungeon- or app-specific shapes (those live next to the code that owns them)

## What is here

| Module | Exports |
| --- | --- |
| `ids` | `newId(kind)`, `parseId`, `tryParseId`, `isId(kind[, value])`, `isAnyId`, `atlasId(kind)` (zod), `AnyAtlasId`, `ID_KINDS` |
| `common` | `SchemaVersion` (`1`), `IsoTimestamp`, `DottedName`, `Sha256Hex` |
| `capabilities` | `CapabilityScope`, `ResourceConstraint`, `Grant` |
| `jobs` | `JobStatus`, `JobRecord`, `JobProgress`, `JobCheckpoint`, `JobRetry`, `JobCancellation`, `JobFailure`, `JobFailureClass` |
| `events` | `EventEnvelope`, `EventSubject` |
| `provenance` | `Provenance`, `SourceInput`, `ToolCallRecord`, `ProvenanceEdit`, `ModelRef` |
| `storage` | `BlobRef`, `Manifest`, `ManifestEntries`, `createManifest`, `manifestDigest`, `verifyManifest`, `canonicalManifestEncoding` |
| `nexus` | `CapabilityAlias`, `ModelCapabilities`, `ModelDescriptor`, `RouteRequest`, `RouteRequirements`, `RoutePolicy`, `RouteDecision`, `RouteTrace` |

## Conventions

- **IDs** are `<kind>_<ULID>`: lowercase prefix (`prj`, `file`, `art`, `job`, `conv`, `site`,
  `chap`, `char`, `res`, `evd`, `dep`, `mdl`, `rev`, `blob`, `trace`, `evt`), underscore, then a
  26-character Crockford base32 ULID (48-bit ms timestamp + 80 random bits). IDs sort by creation
  time within a kind. Use `newId('job')`; never build ids by string concatenation.
- **Timestamps** are ISO 8601 strings with an explicit offset (`IsoTimestamp`), never `Date`
  objects or epoch numbers, so persisted JSON round-trips losslessly.
- **Names** of job kinds and event types are lowercase dotted (`writing.draft-chapter`,
  `job.progress.updated`).
- **Persisted shapes** (`Grant`, `JobRecord`, `EventEnvelope`, `Provenance`, `Manifest`,
  `RouteTrace`) carry `schemaVersion: 1`. Bump the literal and add a migration when the shape
  changes incompatibly; do not silently widen.
- **Manifest digest** is sha256 over the canonical encoding: entries sorted by path, one
  `<path>\t<digest>\t<size>\t<mediaType>\n` line each.
- Each zod schema is exported under the same name as its inferred type
  (`JobRecord` is both a value and a type).
