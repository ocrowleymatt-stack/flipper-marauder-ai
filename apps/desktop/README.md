# @atlas/app-desktop

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

Desktop shell: packages the web UI with local runtime integration (window, tray, local file access).

## Must NOT contain

- a second copy of the web UI (compose `@atlas/ui` and `@atlas/app-web` instead)
- platform logic
- direct provider/model calls

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
