# Monorepo layout

npm workspaces. Node 22. Native `node:test`. TypeScript 5.8.
Package name prefix: `@atlas-vnext/*`.

```text
flipper-marauder-ai/
  README.md
  docs/architecture/          # this design gate (source of truth)
  docs/adr/
  architecture/
    dependency-rules.json     # machine-checked import graph
    nexus-budget.json
  packages/
    contracts/                # JSON Schema + TS types (no runtime I/O)
    plugin-sdk/               # dungeon/tool/UI contracts (interfaces only)
    provider-spi/             # ProviderAdapter + error taxonomy (interfaces)
    storage/                  # CAS interface + in-memory stub
    eval/                     # routing eval harness stub
  services/
    nexus/                    # SMALL router only
    broker/                   # execution, jobs, permissions choke point
    edge/                     # auth/pairing stub
  dungeons/
    investigation/
    writing/
    research/
    website-studio/
    music/
    quantum/
    device-marauder/          # Flipper/Marauder (outside Mountain)
  apps/
    shell/                    # thin UI stub
  tests/
    architecture/             # boundary tests (CI)
    contracts/                # schema/type agreement
  .github/workflows/ci.yml
```

## Ownership

| Area | Owner | May depend on |
|---|---|---|
| `packages/contracts` | Platform | nothing |
| `packages/plugin-sdk` | Platform | contracts |
| `packages/provider-spi` | Platform | contracts |
| `packages/storage` | Platform | contracts |
| `packages/eval` | Platform | contracts |
| `services/nexus` | Platform | **contracts only** |
| `services/broker` | Platform | contracts, plugin-sdk, provider-spi, storage |
| `services/edge` | Platform | contracts |
| `dungeons/*` | Domain | contracts, plugin-sdk |
| `apps/shell` | Shell | contracts |

## Illegal dependencies (CI-enforced)

- `services/nexus` → broker internals, dungeons, provider-spi, storage, vendor SDKs
- `dungeons/A` → `dungeons/B`
- `dungeons/*` → `services/nexus`, `provider-spi`, vendor SDKs
- Any package → `atlas-mountain`, `@atlas/*` Mountain internals, relative `../atlas-mountain`
- Product code putting/getting storage by filesystem path instead of `ContentAddress`
- Product code checking `roles` / `groups` on broker execute

Apps talk to the **edge HTTP API**, not to dungeon packages.

## Nexus budget

`architecture/nexus-budget.json`:

- max production TS/JS lines: 500
- max files: 8
- forbidden identifier substrings in nexus src: `retry`, `failover`,
  `dungeon`, `runpod`, `ollama`, `openai`, `anthropic`, `jobStore`

Exceptions only by ADR, not by comment.
