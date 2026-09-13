# @atlas/app-mobile

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

Mobile shell: a thin client that talks to a running Atlas platform over the SDK.

## Must NOT contain

- platform logic
- a fork of the web UI
- direct storage access

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
