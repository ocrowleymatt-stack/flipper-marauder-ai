# @atlas/dungeon-music

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

Music workflows: composition, arrangement and rendering jobs.

## Must NOT contain

- imports of other `dungeons/*`
- imports of `apps/*`
- GPU runtime specifics (that is `runtimes/*`)

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
