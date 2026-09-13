# @atlas/sdk

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

Typed client that apps use to talk to the platform. Speaks only in `@atlas/contracts` types.

## Must NOT contain

- platform implementation
- UI components
- imports of `platform/*` internals (only public API surfaces once they exist)

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
