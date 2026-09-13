# @atlas/platform-jobs

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

Durable jobs: queueing, checkpoints, retry, cancellation and resume for `JobRecord`s, independent of what the job does.

## Must NOT contain

- job-kind-specific logic (dungeons register handlers)
- event transport internals
- model routing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
