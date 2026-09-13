# @atlas/platform-provenance

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

Records and queries `Provenance` for every artifact: inputs, models, tool calls, jobs and edits.

## Must NOT contain

- content generation
- its own blob storage
- search indexing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
