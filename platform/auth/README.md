# @atlas/platform-auth

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

Identity and sessions: who is calling, and how that was established.

## Must NOT contain

- authorisation decisions (that is `@atlas/platform-permissions`)
- UI
- capability grant evaluation

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
