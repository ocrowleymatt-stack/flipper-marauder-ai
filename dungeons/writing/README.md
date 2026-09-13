# @atlas/dungeon-writing

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

Long-form writing workflows: chapters, characters, revisions and drafting jobs.

## Must NOT contain

- imports of other `dungeons/*`
- imports of `apps/*`
- direct provider/model calls (route through `@atlas/platform-nexus`)

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
