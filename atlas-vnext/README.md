# Atlas vNext

Design-gate workspace for the Atlas rebuild.

> Atlas Mountain is a behavioural reference, not an architectural template.

This directory is independent of Atlas Mountain’s `services/nexus` god-service, turbo `apps/*` layout, `/v12` shims, and string-needle contract scripts. The Flipper Zero tree at the repository root is left untouched.

## What this PR ships

- Architecture review, capability census, and domain/storage/job/nexus docs
- Shared contracts (`packages/contracts`)
- Thin Nexus router (`platform/nexus`) — routing, discovery, policy only
- Execution interfaces + broker (`platform/execution`) — retries, circuit breakers, streaming
- Empty platform primitive shells: projects, jobs, events, storage, provenance, permissions
- Empty dungeon shells with README boundaries
- **Import-graph architecture tests** that fail on forbidden TypeScript imports and `package.json` dependencies

## What this PR does not ship

See [docs/WHAT-WE-DELIBERATELY-DID-NOT-PORT.md](docs/WHAT-WE-DELIBERATELY-DID-NOT-PORT.md). No bulk copy of legacy implementation. No OSINT/writing/investigation product.

## Test

```bash
cd atlas-vnext
npm install
npm test
```
