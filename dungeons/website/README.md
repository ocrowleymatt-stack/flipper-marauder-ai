# @atlas/dungeon-website

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

Website building workflows: site models, pages, generation and deployment requests.

## Must NOT contain

- imports of other `dungeons/*`
- imports of `apps/*`
- deployment mechanics (that is `runtimes/*` and `ops/deploy`)

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
