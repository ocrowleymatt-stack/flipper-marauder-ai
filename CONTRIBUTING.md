# Contributing to Atlas vNext

## Core principle

> **Atlas Mountain is a behavioural reference, not an architectural template.**

Legacy repositories tell us *what* Atlas must do (behaviours, contracts, tests, operational
lessons). They do not tell us *how* this codebase is shaped. Read them; do not port them.
Do not bulk-copy implementation from Atlas Mountain or other legacy repositories before the
design gate is complete.

## Toolchain

- Node 22 (`.nvmrc`), npm 10 workspaces, TypeScript 5 (strict, ESM, `NodeNext`), vitest, zod, oxlint.
- `npm install` once at the root. Never run `npm install` inside a workspace directory.
- `npm run check` runs everything CI runs: `boundaries`, `typecheck`, `lint`, `test`, `build`.
- Keep `package-lock.json` committed. npm 10.9's resolver crashes (`Cannot read properties of
  null (reading 'edgesOut')`) when it has to resolve vitest 4.1's optional peer set from scratch;
  with the lockfile present, `npm install`, `npm ci` and adding dependencies all work normally.
  If you ever have to regenerate the lockfile, run `npm install --legacy-peer-deps` once.

## Repository layout

| Path | Contains | npm package |
| --- | --- | --- |
| `apps/*` | thin shells (web, desktop, mobile) | `@atlas/app-<name>` |
| `platform/*` | the platform: nexus, execution, auth, projects, storage, jobs, events, permissions, provenance, search, observability | `@atlas/platform-<name>` |
| `dungeons/*` | plugin-style domain workflows (writing, investigation, research, website, music, osint) | `@atlas/dungeon-<name>` |
| `runtimes/*` | where the platform runs (local, hetzner, runpod) | `@atlas/runtime-<name>` |
| `packages/*` | cross-cutting libraries: contracts, sdk, ui, config, testing, shared | `@atlas/<name>` |
| `ops/*` | deploy, backup, monitoring: scripts and runbooks, **not** npm packages | – |
| `docs/` | design documents | – |
| `scripts/` | repo-level tooling (`check-boundaries.mjs`) | – |

Every workspace package has the same shape: `package.json`, `tsconfig.json` (extends
`../../tsconfig.base.json`), `src/index.ts`, `README.md` stating its single responsibility and
what it must **not** contain, and optional `src/**/*.test.ts`.

## Dependency-boundary rules

Enforced by `npm run boundaries` (`scripts/check-boundaries.mjs`), which reads every workspace's
`package.json` and scans `src/` for `@atlas/*` imports:

1. `packages/contracts` depends on **nothing** in this repository. It is the shared language.
2. `platform/nexus` may depend only on `@atlas/contracts`, `@atlas/shared`, `@atlas/config` and
   `@atlas/platform-observability`. Never on execution, storage, projects, jobs or any dungeon.
   Nexus routes; it does not execute.
3. `platform/*` never depends on `dungeons/*` or `apps/*`. The platform does not know which
   dungeons exist; dungeons register into it.
4. `dungeons/*` never depend on other `dungeons/*` or on `apps/*`. Dungeons share things by
   pushing them down into `platform/*` or `packages/*`, never sideways.
5. `runtimes/*` never depend on `dungeons/*` or `apps/*`.
6. Every `@atlas/*` import must be declared in that package's `package.json`, and every runtime
   `dependency` on a workspace must have a matching `references` entry in `tsconfig.json`.

When a rule blocks you, the fix is almost always "move the shared thing to `contracts`/`shared`
or expose it through a platform API", not "add an exception".

## Adding a dependency between packages

1. In the consumer's `package.json`, add `"@atlas/<name>": "0.0.0"` under `dependencies`
   (or `devDependencies` if only tests use it).
2. For runtime dependencies, add `{ "path": "../../<group>/<dir>" }` to the consumer's
   `tsconfig.json` `references`.
3. Run `npm install` at the root so the workspace symlink exists, then `npm run boundaries`.

Workspace packages expose three export conditions: `atlas-source` (`src/index.ts`, used by
vitest and by `tsconfig.tests.json` so tests never need a build), `types` (`dist/index.d.ts`)
and `default` (`dist/index.js`).

## Adding tests

Put `*.test.ts` next to the code in `src/`. They are excluded from the package build and picked
up by the root vitest config (`vitest.config.ts`, one project per workspace group) and typechecked
by `tsconfig.tests.json`. Run everything with `npm test`, or one package with
`npm test -w @atlas/<name>`. Use `@atlas/testing` for clocks, deferreds and stream collection.

## Adding a workspace package

Copy the shape of an existing placeholder (for example `platform/search`), give it the
`@atlas/<segment>-<name>` name, add `{ "path": "<group>/<dir>" }` to the root `tsconfig.json`
`references`, and write the README's "Must NOT contain" section before writing code.

## Conventions

- Placeholders must be honest: export `PACKAGE_NAME` and nothing that pretends to work.
- Persisted data shapes live in `@atlas/contracts` with a `schemaVersion` literal.
- IDs come from `newId(kind)`; timestamps are ISO strings; names are lowercase dotted.
- No comments that narrate code. Explain intent, trade-offs or constraints only.
- Prefer few dependencies. Adding a runtime dependency to `platform/*` needs a stated reason in the PR.
