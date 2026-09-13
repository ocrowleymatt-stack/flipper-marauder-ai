# Nexus contract

Nexus is the decision plane. Small, stable, boring.

## Owns

- Provider/model registry
- Capability aliases
- Ranking policy
- Recorded health snapshots
- `RouteDecision` traces

## Does not own

- HTTP/fetch to providers
- SSE/NDJSON parsing
- Retries / circuit breakers
- Jobs, SQL, dungeons, Caspa, OSINT

## Aliases

`nexus/fast`, `nexus/reason`, `nexus/code`, `nexus/vision`, `nexus/cheap`, `nexus/local`, `nexus/frontier`.

Explicit `provider/model` bypasses alias ranking but still checks registration, health, and requirements.

## `RouteDecision`

target, resolvedRouteId, provider, model, candidateChain, localOnly, decisionReason, traceId, evaluatedAt.

Handoff: caller passes the decision to `ExecutionBroker`. Nexus does not invoke adapters.

## Invariants (tested)

1. `nexus/fast` → fast healthy candidate  
2. `nexus/reason` → reasoning  
3. `nexus/code` → code  
4. `nexus/vision` → vision  
5. Explicit routes work  
6. Unhealthy excluded  
7. Failover before tokens — **execution**  
8. No second stream after visible text — **execution**  
9. Tools requirement honoured  
10. Context window rejected before transport  
11. `nexus/local` never cloud  
12. `nexus/cheap` lowest cost class  

Legacy AM aliases (`nexus/instant`, `nexus/deep`, `nexus/adversarial`, …) are **not** part of vNext.
