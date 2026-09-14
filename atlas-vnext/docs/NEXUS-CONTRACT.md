# Nexus contract

Nexus is the decision plane. Small, stable, boring. Data-driven: adding a model is a registry change, not a router rewrite.

## Owns

- Provider/model registry (provider, model ID, text, reasoning, tools, vision, code, context window, cost class, latency class, locality, health, privacy eligibility, runtime requirements)
- Capability aliases and ranking policy (`ALIAS_POLICIES`)
- Auto / Power-Pod specialist/fallback ranking (not alias-table keys)
- Recorded health snapshots
- Request normalisation and immutable `RouteDecision` traces
- Cost / latency / locality / local-only privacy policy

## Does not own

- HTTP/fetch to providers
- SSE/NDJSON parsing
- Retries / timeouts / circuit breakers
- Worker lifecycle, tool execution
- Jobs, SQL, dungeons, Caspa, OSINT, Writing, Website Studio, Investigation, Research, project storage, browser/local-device execution

## Aliases

`nexus/fast`, `nexus/reason`, `nexus/code`, `nexus/vision`, `nexus/cheap`, `nexus/local`, `nexus/frontier`.

Explicit `provider/model` bypasses alias ranking but still checks registration, health, requirements, and privacy.

## `RouteDecision`

target, resolvedRouteId, provider, model, candidateChain, rejectedCandidates, localOnly, decisionReason, traceId, evaluatedAt, optional delegation (`auto` / `power_pod`).

Handoff: caller passes the decision to `ExecutionBroker`. Nexus does not invoke adapters. Adapter exceptions therefore cannot crash the router.

## Invariants (tested)

1. `nexus/fast` → fast healthy candidate (deterministic fixture)
2. `nexus/reason` → reasoning. vNext ranks registered reasoners (host catalogue `grok-build` is fast); this is **not** Mountain’s anthropic-primary table @ `5cc7a964…`. Public xAI never satisfies `local_only` (Mountain #172).
3. `nexus/code` → code
4. `nexus/vision` → vision
5. `nexus/cheap` → lowest cost class
6. `nexus/local` never cloud
7. `nexus/frontier` → high cost or reasoning
8. Explicit routes work; missing provider rejected
9. Unhealthy excluded
10. Tools requirement honoured
11. Context window rejected before transport
12. Local-only privacy policy excludes cloud
13. Adding one provider does not alter unrelated aliases unexpectedly
14. Malformed metadata rejected at registration
15. Failover before tokens / no second stream after visible text — **execution**
16. Auto / Power-Pod is specialist/fallback ranking, not an alias-table lookup — **nexus** (`auto` / `power-pod` targets)
17. Private / local-only never selects public-cloud; missing local fail-closes — **nexus**

See [MOUNTAIN-COMPAT.md](./MOUNTAIN-COMPAT.md).

Legacy AM aliases (`nexus/instant`, `nexus/deep`, `nexus/adversarial`, …) are **not** part of vNext.
