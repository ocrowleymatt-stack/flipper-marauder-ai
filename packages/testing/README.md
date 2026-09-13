# @atlas/testing

Tiny, dependency-free helpers shared by test suites across the monorepo.

## Single responsibility

Make deterministic tests easy: control time, drain streams, drive promises by hand.

## Must NOT contain

- a test runner, assertion library or mocking framework (vitest already provides those)
- fixtures that encode domain knowledge (keep those next to the package under test)
- anything imported by production code

## Helpers

- `fakeClock(start?)` -> `{ now(), nowIso(), advance(ms), set(instant) }`
- `collect(iterable)` -> `Promise<T[]>` for async or sync iterables
- `deferred<T>()` -> `{ promise, resolve, reject, settled }`

Add this package as a `devDependency` (never a `dependency`) of the package whose tests use it.
Because `*.test.ts` files are excluded from the per-package build, no `tsconfig.json`
`references` entry is needed for test-only dependencies.
