# @atlas/platform-observability

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

Traces, metrics, structured logs and evaluation hooks. Leaf package that every other platform package may depend on.

## Must NOT contain

- dependencies on any other `platform/*` package
- business logic
- UI

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
