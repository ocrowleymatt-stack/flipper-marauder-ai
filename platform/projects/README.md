# @atlas/platform-projects

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

Durable project aggregate: project metadata, the objects and revisions a project owns, and their lifecycle.

## Must NOT contain

- blob bytes (that is `@atlas/platform-storage`)
- job execution
- dungeon-specific object semantics

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
