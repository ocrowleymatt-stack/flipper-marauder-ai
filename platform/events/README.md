# @atlas/platform-events

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

Event backbone: publish, persist, subscribe to and replay `EventEnvelope`s with ordering guarantees.

## Must NOT contain

- interpretation of payloads
- the job state machine
- UI concerns

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
