# Atlas vNext

Greenfield rebuild of Atlas.

> Atlas Mountain is a behavioural reference, not an architectural template.

This repository is intentionally starting from a clean architectural foundation. Existing Atlas-related repositories are reference sources for proven behaviour, contracts, tests and operational lessons; they are not to be copied wholesale.

Initial priorities:

- repository capability census
- architecture and domain boundaries
- durable projects and durable jobs
- event-driven progress
- content-addressed storage
- explicit provenance
- capability-based permissions
- thin Nexus router plus separate execution broker
- plugin-style Dungeons
- built-in observability, evaluation, backup and transactional deployment

Do not bulk-copy implementation from Atlas Mountain or other legacy repositories before the design gate is complete.

## Repository layout

npm-workspaces monorepo (Node 22, TypeScript 5, vitest, zod, oxlint). Every leaf below is a workspace package named `@atlas/...`; `ops/*` and `docs/` are not packages.

```
apps/        web  desktop  mobile                       @atlas/app-<name>
platform/    nexus  execution  auth  projects  storage  jobs  events
             permissions  provenance  search  observability   @atlas/platform-<name>
dungeons/    writing  investigation  research  website  music  osint   @atlas/dungeon-<name>
runtimes/    local  hetzner  runpod                     @atlas/runtime-<name>
packages/    contracts  sdk  ui  config  testing  shared   @atlas/<name>
ops/         deploy  backup  monitoring                 (runbooks and scripts only)
docs/        design documents (see docs/README.md)
scripts/     repo tooling (check-boundaries.mjs)
```

Most packages are placeholders that export only `PACKAGE_NAME`; their READMEs state each package's single responsibility and what it must not contain. Substantive code so far: `packages/contracts` (zod schemas for ids, capabilities, jobs, events, provenance, storage, nexus routing), `packages/config` (feature flags) and `packages/testing` (test helpers).

## Checks

```sh
npm install
npm run check        # boundaries + typecheck + lint + test + build
npm run boundaries   # dependency-boundary lint (scripts/check-boundaries.mjs)
npm run typecheck    # tsc -b for packages, plus tests via tsconfig.tests.json
npm run lint         # oxlint
npm test             # vitest (all workspaces)
npm run build        # tsc -b -> <package>/dist
```

Boundary rules, package conventions and how to add packages, tests and dependencies are in [CONTRIBUTING.md](CONTRIBUTING.md).
