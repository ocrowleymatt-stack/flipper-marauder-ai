# Atlas vNext

Greenfield workspace for the Atlas rebuild.

> Atlas Mountain is a behavioural reference, not an architectural template.

This directory is independent of Atlas Mountain’s `services/nexus` god-service, turbo `apps/*` layout, `/v12` shims, and string-needle contract scripts. The Flipper Zero tree at the repository root is left untouched.

## Conversation spine (Tranche 1)

A user can open the Atlas workspace, create a conversation, send a prompt, receive a streamed model response (Nexus routes, execution runs), reload, and still have the thread.

```bash
cd atlas-vnext
npm ci
npm run dev
```

UI: http://127.0.0.1:5173 — API/SSE: http://127.0.0.1:8787

Default providers are in-process mocks (no API keys). `nexus/fast` and `nexus/reason` are real capability routes with recorded provider/model provenance.

## What this tree contains

- Architecture review, capability census, domain/storage/job/nexus docs
- Shared contracts (`packages/contracts`)
- Thin Nexus router (`platform/nexus`)
- Execution broker (`platform/execution`)
- Conversation domain + durable file metadata store
- Workspace UI (`apps/web`) and HTTP/SSE host (`apps/host`)
- Import-graph architecture tests

## What this does not ship

See [docs/WHAT-WE-DELIBERATELY-DID-NOT-PORT.md](docs/WHAT-WE-DELIBERATELY-DID-NOT-PORT.md). No Caspa, Mnemosyne, Website Studio, Music, OSINT, or autonomous research migration.

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
