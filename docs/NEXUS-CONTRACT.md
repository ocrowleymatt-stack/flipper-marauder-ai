# Nexus contract

Nexus is a pure routing component. It is stable when the tests in `platform/nexus/test/contract.test.ts` (and execution tests that consume its decisions) pass.

## Registry (declarative)

```text
Provider
  id                "anthropic" | "openai" | "gemini" | "venice" | "ollama" | "runpod" | "hetzner" | …
  locality          local | cloud
  health            healthy | degraded | unhealthy | unknown

Model
  providerId
  id                vendor model id
  capabilities
    text            boolean
    reasoning       boolean
    tools           boolean
    vision          boolean
    code            boolean
  contextWindow     tokens (input+output budget as advertised)
  costClass         zero | low | medium | high
  latencyClass      low | medium | high
  health            healthy | degraded | unhealthy | unknown
```

Adding a model is a registry edit, not a router rewrite.

## Aliases

Applications request aliases. Defaults (policy in `platform/nexus` config, overridable):

| Alias | Intent | Selection |
|---|---|---|
| `nexus/fast` | Low latency general text | `text`, prefer `latencyClass=low`, then lower `costClass` |
| `nexus/reason` | Deliberate reasoning | require `reasoning` |
| `nexus/code` | Code + tools | require `code` and `tools` |
| `nexus/vision` | Images/docs | require `vision` |
| `nexus/cheap` | Lowest cost that still fits requirements | rank `costClass` ascending, `zero` first |
| `nexus/local` | Never leave the machine | `locality=local` only |
| `nexus/frontier` | Strongest available | prefer `reasoning` + `costClass=high` |

Deprecated Mountain aliases (`nexus/instant`, `nexus/private`, `nexus/deep`, …) are **not** implemented in vNext. Apps map them at the edge if a migration shim is needed.

Applications may also pass `explicit: { providerId, modelId }` for tests and power users. Explicit targets **do not** receive candidate failover at Nexus layer. Execution must not invent extra candidates for an explicit decision.

## Route request

```text
RouteRequest
  alias?: CapabilityAlias
  explicit?: { providerId, modelId }
  requirements?:
    tools?, vision?, reasoning?, code?, text?
    minContextWindow?
  policy?:
    localOnly?
    costPreference?: cheapest | balanced | frontier
  traceId?
```

Normalisation: if both `alias` and `explicit` are set, **explicit wins** and alias is recorded on the trace as ignored. If neither is set, Nexus fails (`route.invalid_request`).

## Route decision

```text
RouteDecision
  candidates: [{ providerId, modelId, reason }]   ordered
  trace: RouteTrace
```

`candidates[0]` is the intended primary. Execution may walk the tail only for capability-alias decisions after classified transport failure with **no visible output**.

## Trace (required fields)

- `traceId`
- `alias` / `explicit` as requested
- `attempted` — models considered
- `excluded` — `{ model, reason }` where reason ∈ `unhealthy | locality | capability | context_window | flagged | unknown`
- `selected` — ordered candidate ids
- `ts`, `schemaVersion`

Nexus does **not** record HTTP latency or token cost; it has not called a provider.

## Health

Unhealthy models are excluded from alias resolution. Degraded models sort after healthy ones of equal rank. `unknown` is treated as degraded, not as healthy.

Health writers: execution probes, operator config, runtime heartbeats. Nexus only *reads*.

## What Nexus will never do

- `fetch` a provider
- retry
- buffer streams
- open circuit breakers (it may *read* a health field that execution updated)
- inspect prompt text to pick an alias (auto-route is an app concern)

## Contract tests (this phase)

1. `nexus/fast` resolves to a low-latency text model when one is healthy.
2. `nexus/reason` resolves to a reasoning model.
3. `nexus/code` resolves to a tools+code model.
4. `nexus/vision` resolves to a vision model.
5. Explicit `{provider, model}` returns that pair.
6. Unhealthy providers/models are absent from alias candidates.
7. Execution: provider failure before output walks to the next Nexus candidate.
8. Execution: partial visible stream never starts a second model.
9. Tool requirement excludes `tools: false` models.
10. `minContextWindow` excludes smaller windows.
11. `nexus/local` and `policy.localOnly` never return `locality=cloud`.
12. `nexus/cheap` / `costPreference: cheapest` picks the lowest `costClass` that satisfies requirements.
13. `nexus/frontier` prefers high cost-class reasoning models.
14. Explicit unhealthy target fails closed (no fallback list).

## Execution handshake

Nexus returns the list. Execution reports attempts back through events, not by calling Nexus again. If all candidates fail, the job fails with the last classified error; Nexus is not asked to “think harder”.
