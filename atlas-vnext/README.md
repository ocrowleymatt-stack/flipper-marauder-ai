# Atlas vNext

Greenfield workspace for the Atlas rebuild.

> Atlas Mountain is a behavioural reference, not an architectural template.

This directory is independent of Atlas Mountain’s `services/nexus` god-service, turbo `apps/*` layout, `/v12` shims, and string-needle contract scripts. The Flipper Zero tree at the repository root is left untouched.

## Conversation + live providers

A user can open Atlas, pick Fast or Reason, send a prompt, receive a streamed reply from a real provider (when credentials exist), reload, and still have the thread. Provenance looks like `Fast · OpenAI · gpt-4o`.

```bash
cd atlas-vnext
npm ci
npm run dev
```

UI: http://127.0.0.1:5173 — API/SSE: http://127.0.0.1:8787

Default runtime is **live** adapters. Missing keys mark that provider unavailable; the process does not crash. `ATLAS_USE_MOCK_PROVIDERS=1` forces in-process mocks. See [docs/LIVE-PROVIDERS.md](docs/LIVE-PROVIDERS.md).

## What this tree contains

- Architecture review, capability census, domain/storage/job/nexus docs
- Mountain behavioural compatibility contracts (`docs/MOUNTAIN-COMPAT.md`, `tests/compat`)
- Shared contracts (`packages/contracts`)
- Thin Nexus router (`platform/nexus`)
- Execution broker + production adapters (`platform/execution`)
- Conversation domain + PostgreSQL persistence kernel (JSON file remains local/dev)
- Tool platform, plugins, Authority, authentication, secrets, health/recovery (`docs/TOOLS-AUTH-AUTHORITY.md`)
- Projects/files/CAS/context foundation (`docs/FILES-AND-CONTEXT.md`)
- Workbench UI (`apps/web`) over host HTTP/SSE (`apps/host`) — session, projects, runs, files, tools, Authority approval (`docs/WORKBENCH.md`)
- Caspa Writing dungeon (`dungeons/writing`) — durable documents, versions, selected-file context (`docs/CASPA-WRITING.md`)
- Production-readiness gate (`docs/PRODUCTION.md`, `docs/RUNBOOKS.md`) — config contract, health, limits, failure drills, GO/NO-GO. Cutover is human-gated.
- Import-graph architecture tests

## What this does not ship

See [docs/WHAT-WE-DELIBERATELY-DID-NOT-PORT.md](docs/WHAT-WE-DELIBERATELY-DID-NOT-PORT.md). No Mnemosyne, Website Studio, Music, OSINT, or autonomous research migration. Caspa historical product UI/routers are not ported; the Writing dungeon is platform-native.

## Test / CI

```bash
cd atlas-vnext
npm ci
npm run lint
npm run typecheck
npm test
npm run test:boundaries
npm run test:providers
npm run test:persistence
npm run test:files
npm run test:tools
npm run test:caspa
npm run test:production
npm run config:validate
npm run advisories:classify
npm run test:runtime
npm run test:compat
npm run build
```

Optional live smoke (not CI): `ATLAS_LIVE_SMOKE=1 OPENAI_API_KEY=... npm run smoke:live`
