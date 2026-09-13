# @atlas/shared

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

Small pure utilities with no I/O: result/error helpers, assertions, string and time helpers.

## Must NOT contain

- I/O of any kind
- domain concepts
- runtime schemas (those are `@atlas/contracts`)

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
