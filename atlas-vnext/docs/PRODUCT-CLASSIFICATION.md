# Product classification (design gate)

This branch is architecture/foundation only. No production migration.

| Path | Classification |
|---|---|
| `packages/contracts` | **interface** — Zod contracts |
| `platform/nexus` | **foundation primitive** — registry + data-driven router |
| `platform/execution` | **foundation primitive** — broker, breaker, adapter interface, mock adapter |
| `platform/permissions` | **foundation primitive** — default-deny gate (grants persistence deferred) |
| `platform/jobs` | **interface** + job transition table; durable engine deferred |
| `platform/events`, `storage`, `projects`, `provenance`, `observability`, `flags` | **interface** / thin skeleton |
| `dungeons/*` | **thin skeleton** — id/title/description only |
| `tests/architecture` | **test fixture** + import-graph checker |
| `tests/architecture/fixtures/violations/nexus-forbidden.ts` | **negative fixture** proving CI failure when treated as Nexus source |

No files under writing, investigation, research, website, or OSINT contain product logic. If later PRs add substantial dungeon implementations before a per-subsystem design review, they must be deferred.

Premature product logic **not present** (and still rejected if proposed): Caspa GoldPipeline, StoryBible, who() implementation, BigBrother scanners, provider HTTP adapters, Website Studio preview servers, OpenWebUI shims.
