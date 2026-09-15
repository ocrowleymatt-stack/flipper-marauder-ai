# WHAT WE DELIBERATELY DID NOT PORT

First-principles rebuild. Behaviour may be reimplemented later; these implementations stay out of vNext.

## God-service and compatibility

- Atlas Mountain `services/nexus` (the whole Fastify god-service), when that TypeScript tree is available
- Domain folders inside that service: writing, research, investigation, quantum, music, attachments, auth, jobs, website preview
- nginx `/v12` shims and preview path regexes
- OpenWebUI compatibility and `/v12` conversation-shaped long-term APIs
- String-needle `scripts/check-*-contract.mjs` “architecture tests”
- Patch / copy-migration scripts (`copy-migrations.mjs`, `migrate-legacy-env.mjs`)
- Previous agents’ in-memory jobs/CAS/permissions engines pretending to be the platform
- Duplicate Atlas vNext branches (`99e9`, `057e`, `6252`, `694c`, `e2ed`, `66f8`, `8647`, …) as source of truth
- The Java/Spring Boot/MySQL `lystrosaurus/atlas-mountain` stub and any census derived from it

## Product dungeons (deferred / not copied)

- Caspa `src/services` GoldPipeline, StoryBible, PlotArchitect, jobQueue, routers (behavioural lessons only; Writing dungeon is platform-native)
- Shakespeare- Gemini studio app
- Investigation orchestration and caseboard product code
- Website Studio product + Nexus-mounted preview servers
- Music / ACE-Step / RunPod writing-music providers
- OSINT product: `@ocrowley/osint` `who()` implementation, TheBigBrother scanners, AM `bigbrother.ts`, Caspa osint routes
- Duplicated site trees / per-revision `node_modules`
- Parallel writing stores (Caspa PG + Shakespeare + AM folders + commons literary DBs as separate systems of record)

## Transport and shared libraries (as copies)

- AM provider HTTP adapters (OpenAI, Anthropic, Gemini, Ollama, RunPod, Venice)
- Caspa `unifiedRouter` / `llmRouter` / `cloudModelRouter` / `routerFailover`
- `@ocrowley/ai-client` as the control plane
- Direct Dungeons-to-provider calls
- commons package implementations (`jobs`, `persistence`, `literary-*`, `darkweb`, …) as the platform
- Life-os Daedalus factory (planner/builder/Themis) as Atlas runtime
- Fragile string-based contract tests

## Ops and local control (as copies)

- `atlas-companion.mjs` / `atlas-device-relay.mjs` monoliths
- Hetzner deploy shell as-is (keep the *idea* of atomic symlink + rollback)
- Caspa nginx identity / SSH deploy workflow sprawl and one-off diagnostic Actions
- Per-domain job runners (`commission-runner`, `research/runner`, `whoWorker`, `setInterval` loops)
- Old deployment hacks superseded by transactional deploy (archiveB64, live-baseline one-offs)
- Obsolete experimental repos not selected as canonical behaviour (hanflow, spiral-mind, craigs-navigator)

## Storage anti-patterns

- `attachments.content_base64` and any blobs-in-SQLite / blobs-in-Postgres-row scheme
- Ad-hoc project folders without manifests
- Multiple databases as the default topology

## Fashionable infra we are not introducing

Kafka, Kubernetes, Temporal, service mesh, microservices-as-architecture.

## Why

Porting those trees would reproduce the coupling this design gate exists to prevent. The next implementation PRs should re-create proven behaviour against the contracts and layers defined here.
