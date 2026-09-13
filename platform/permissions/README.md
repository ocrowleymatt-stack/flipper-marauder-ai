# @atlas/platform-permissions

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

Capability-based authorisation: evaluates `Grant`s and `CapabilityScope`s against requested actions and resources.

## Must NOT contain

- authentication
- execution of the granted action
- UI prompts

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
