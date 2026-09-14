# Atlas vNext

Design-gate workspace for the Atlas rebuild.

> Atlas Mountain is a behavioural reference, not an architectural template.

Canonical branch: `cursor/atlas-vnext-design-gate-2e35`. Duplicate `atlas-vnext-*` branches are not source of truth.

This directory is independent of Atlas Mountain’s `services/nexus` god-service, turbo `apps/*` layout, `/v12` shims, and string-needle contract scripts. The Flipper Zero tree at the repository root is left untouched.

## What this PR ships

- Architecture review, capability census (with inspection honesty), domain/storage/job/nexus/website/writing/OSINT/deploy/backup docs
- Shared contracts (`packages/contracts`)
- Thin Nexus router (`platform/nexus`) — routing, discovery, policy only; Zod registration boundary
- Execution interfaces + broker (`platform/execution`)
- Platform primitive shells + default-deny permissions + job transitions
- Empty dungeon shells
- **Import-graph architecture tests** plus a negative fixture that fails CI when treated as Nexus source

## What this PR does not ship

See [docs/WHAT-WE-DELIBERATELY-DID-NOT-PORT.md](docs/WHAT-WE-DELIBERATELY-DID-NOT-PORT.md). No bulk copy of legacy implementation. No OSINT/writing/investigation product.

## Test / CI

```bash
cd atlas-vnext
npm ci
npm run lint
npm run typecheck
npm test
npm run test:boundaries
npm run build
```
