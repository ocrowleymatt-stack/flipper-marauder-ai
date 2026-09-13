# @atlas/platform-execution

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

Execution broker: runs tool calls, shell, browser and device actions under explicit capability grants, isolated from model routing.

## Must NOT contain

- model selection or provider clients
- imports of `@atlas/platform-nexus` internals
- dungeon-specific workflows

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
