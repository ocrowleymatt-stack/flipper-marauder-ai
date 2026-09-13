# @atlas/platform-nexus

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

Thin model router: turns a `RouteRequest` (capability alias or explicit model) into a `RouteDecision` with a full `RouteTrace`, using a model registry and health signals.

## Must NOT contain

- tool or shell execution (that is `@atlas/platform-execution`)
- storage, projects or job state
- knowledge of any dungeon
- anything besides `@atlas/contracts`, `@atlas/shared`, `@atlas/config` and `@atlas/platform-observability` as in-repo dependencies (enforced by `npm run boundaries`)

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
