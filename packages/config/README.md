# @atlas/config

Typed feature flags (and, later, other process-level configuration) for Atlas.

## Single responsibility

Turn declared flags plus environment/file input into a typed, immutable resolution that the
rest of the platform reads from. Nothing here knows what any flag *means*.

## Must NOT contain

- flag definitions for specific features (each package declares its own with `defineFlags`)
- secrets handling (that is `secrets.use` capability territory, not config)
- I/O beyond reading the flags file and environment

## Usage

```ts
import { defineFlags } from '@atlas/config';

export const flags = defineFlags({
  NEXUS_V2_ROUTING: { description: 'route via the new scorer', stability: 'experimental' },
  DURABLE_JOBS: { description: 'persist job records', stability: 'stable' },
});

flags.isEnabled('NEXUS_V2_ROUTING');   // boolean
flags.requireStable('DURABLE_JOBS');   // boolean; throws for experimental flags
flags.resolve('DURABLE_JOBS');         // { value, source: 'default' | 'file' | 'env', stability }
```

## Resolution order

`defaults` (OFF unless `defaultValue: true`) **<** file **<** environment.

- File: JSON object `{ "FLAG_NAME": true }` at `ATLAS_FLAGS_FILE` (or the `file` option).
  A missing file is fine; a malformed one throws at definition time.
- Environment: `ATLAS_FLAG_<NAME>` with `1|true|on|yes` / `0|false|off|no` (case-insensitive).
  Blank means unset; anything else throws.
- Flag names must be `UPPER_SNAKE_CASE` so the env mapping is mechanical.

Resolution happens once, when `defineFlags` runs. Pass `env`/`file`/`readFile` options in tests.

## `requireStable()`

Code paths that must not change behaviour based on experiments (persistence formats, billing,
deployment promotion) read flags through `requireStable(name)`. It throws
`ExperimentalFlagInStablePathError` if the flag's `stability` is `'experimental'`, which makes
accidental coupling of a stable path to an experiment a loud failure rather than a silent drift.
