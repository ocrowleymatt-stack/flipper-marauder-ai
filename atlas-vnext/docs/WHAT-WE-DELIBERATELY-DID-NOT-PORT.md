# WHAT WE DELIBERATELY DID NOT PORT

First-principles rebuild. Behaviour may be reimplemented later; these implementations stay out of vNext.

## God-service and compatibility

- Atlas Mountain `services/nexus` (the whole Fastify god-service)
- Domain folders inside that service: `writing/`, `research/`, `investigation-run-executor.ts`, `quantum/`, `dev-preview.ts`, `site-lifecycle.ts`
- nginx `/v12` shims and preview path regexes
- String-needle `scripts/check-*-contract.mjs` “architecture tests”
- Patch / copy-migration scripts (`copy-migrations.mjs`, `migrate-legacy-env.mjs`)
- Previous agent’s AM vNext in-memory jobs, filesystem CAS, and permissions engines (stubs pretending to be the platform)

## Product dungeons (deferred)

- Caspa `src/services` (GoldPipeline, StoryBible, PlotArchitect, jobQueue, routers)
- Shakespeare- Gemini studio app
- Investigation orchestration and caseboard product code
- Website Studio product + Nexus-mounted preview servers
- Music / ACE-Step / RunPod writing-music providers
- OSINT product: `@ocrowley/osint` `who()` implementation, TheBigBrother scanners, AM `bigbrother.ts`, Caspa osint routes

## Transport and shared libraries (as copies)

- AM provider HTTP adapters (OpenAI, Anthropic, Gemini, Ollama, RunPod)
- Caspa `unifiedRouter` / `llmRouter` / `cloudModelRouter` / `routerFailover`
- `@ocrowley/ai-client` as the control plane
- commons package implementations (`jobs`, `persistence`, `literary-*`, `darkweb`, …)
- Life-os Daedalus factory (planner/builder/Themis) as Atlas runtime

## Ops and local control (as copies)

- `atlas-companion.mjs` / `atlas-device-relay.mjs` monoliths
- Hetzner deploy shell as-is (keep the *idea* of atomic symlink + rollback)
- Caspa nginx identity / SSH deploy workflow
- Per-domain job runners (`commission-runner`, `research/runner`, `whoWorker`)

## Storage anti-patterns

- `attachments.content_base64` and any blobs-in-SQLite scheme
- Ad-hoc project folders without manifests

## Why

Porting those trees would reproduce the coupling this design gate exists to prevent. The next implementation PRs should re-create proven behaviour against the contracts and layers defined here.
