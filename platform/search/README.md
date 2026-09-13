# @atlas/platform-search

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

Indexing and querying across projects, artifacts and events.

## Must NOT contain

- being a source of truth (indexes are rebuildable)
- blob storage
- model routing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
