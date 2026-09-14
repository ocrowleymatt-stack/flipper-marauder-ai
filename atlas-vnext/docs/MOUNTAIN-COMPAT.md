# Mountain behavioural compatibility gate

Atlas vNext architecture is unchanged: **Nexus owns WHERE** (registry, aliases, ranking, health/cost/privacy, immutable `RouteDecision`); **Execution owns HOW** (transport, streaming, retries, circuit breaking, failure classification). This document locks *externally meaningful* Mountain semantics as contracts + tests. It is not a Mountain port.

## Inspection provenance (this PR)

| Source | Status |
|---|---|
| `ocrowleymatt-stack/atlas-mountain` | **Inaccessible** (`gh repo view` / `git clone` → not found). Same as the design-gate census. |
| `ocrowleymatt-stack/atlas`, `Nexus`, `nexus-backend` | **Inaccessible** |
| `/tmp/ref/atlas-mountain` | **Wrong tree**: `lystrosaurus/atlas-mountain` Java/Spring Boot stub. **Not used.** |
| Mountain PRs **#172** / **#221** | **Not inspectable** (repo missing). Encoded from the user-authoritative description: tenant-routed Standard/Open Behaviour, persistent per-tenant resolution, fail-closed defaults, prompt composition, **unchanged Authority**. Open changes **response posture only**. |
| Caspa `routerFailover` / `aiRouterPolicy` | **Inspected** (read-only): billing/transient cooldowns, attempt order, circuit breaker. **Not copied.** Cooldown maps to execution circuit-breaker + Nexus health exclusion. |
| commons `@ocrowley/ai-client` | **Inspected**: Ollama-first failover mixes policy + HTTP — **discard as structure**. |
| vNext `main` @ `ab13570` (PR #4 merge, includes `7c709c36`) | **Inspected**: broker failover-before-output, tool-call buffer, Forge-before-RunPod ranking, local-only privacy, attempt traces. Host catalogue aliases `grok-build` → upstream `grok-build-0.1` (fast reasoning); mountain-compat ranking tests register the same row so Auto/Power-Pod and `nexus/reason` stay aligned. |

Legend used in tests: **specified** = user-stated Mountain requirement; **inspected** = verified against accessible code.

## Compatibility requirements

1. **Failover before output / never after output** — retry/fallback is allowed only before visible assistant text or reasoning. After visible output, no silent provider switch; persist partial content + failure. *(inspected in vNext broker + conversation runtime; specified AM no-double-stream)*
2. **Transactional tool-call buffering** — buffer until the provider attempt completes successfully. A failed attempt must not cause duplicate side effects or execute incomplete fragments. *(inspected assembler + broker buffer)*
3. **Transient retry classification** — timeout / reset / 429 / 5xx: bounded retry. 400 / 401 / unsupported / permission / context overflow: not retried indefinitely. *(specified; Caspa cooldown inspected as adjacent, not copied)*
4. **Local-only Private routing** — Private / `privacy: local_only` never selects public-cloud. Missing local → fail closed, not leak to cloud. *(inspected Nexus privacy; specified Private = local-only)*
5. **Behaviour ≠ Authority** — Open/Standard Behaviour changes response posture only; grants no extra filesystem, shell, network, publishing, compute, or admin capability. *(specified #172/#221)*
6. **Tenant-isolated Behaviour persistence** — per-tenant resolution; tenant A cannot read/write tenant B; fail-closed default is Standard. *(specified #172/#221; stub store)*
7. **Behaviour prompt composed with capability/runtime policy** — posture is composed with (does not replace) capability and runtime policy. *(specified #172/#221; stub composer)*
8. **Auto / Power-Pod delegation** — specialist/fallback, not a dumb alias lookup. Do not wake burst GPU if private/local can satisfy (Forge-before-RunPod). *(specified Auto/Power-Pod; inspected vNext runtime ranking)*
9. **Route observability** — record **actual attempted** providers, not only the winner; include rejects/failures. *(inspected execution attempts; Nexus `rejectedCandidates` added)*
10. **Deployment / resource hygiene** — bounded artefact / workspace / release / event retention under disk pressure; no unbounded log growth. *(specified; RuntimeObserver cap inspected; retention stub)*

## What this PR does not do

- No PostgreSQL product migration, extra providers, RunPod features, Writing, Website Studio, OSINT, or Dungeons as product.
- No bulk-copy of Mountain / Caspa routers.
- No replacement of the Nexus/Execution split.
- Full Behaviour product UI, durable tenant DB, and CAS prune jobs remain **implementation deferred** — locked by fail-closed stubs + tests.
