# @atlas/app-web

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

Browser UI shell for Atlas: pages, navigation and presentation of platform state.

## Must NOT contain

- business or domain logic (lives in `platform/*` and `dungeons/*`)
- direct provider/model calls (go through `@atlas/sdk`)
- direct storage or database access

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
