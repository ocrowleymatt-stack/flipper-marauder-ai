# Atlas vNext — Nexus Contract

The Nexus contract is the load-bearing boundary of the rebuild: it states
exactly what the small/boring router guarantees, what the execution broker
guarantees, and which cases prove it. Census grounding: §§1–5, 16, 23.

---

## 1. Parties and responsibilities

- **Nexus (router):** pure resolution. Input: normalized request (canonical
  target, prompt, project context handle, session capabilities, budgets).
  Output: execution intent `{capability, ordered chain, policy, budgets,
  correlation_id}`. No I/O beyond registry reads. No loops.
- **Execution broker:** executes intents. Owns provider invocation, failover,
  tool execution, jobs, fan-out, permission checks, event emission.
- **Provider registry:** answers `can-serve(provider, capability)` with
  reasons; validates all capability chains at boot.

## 2. Capability table (initial, data — not code)

| Capability | Intent | Primary | Fallbacks | Constraint |
|---|---|---|---|---|
| `nexus/fast` | quick general answers | owned pod (when healthy) | openai → ollama → anthropic → venice | — |
| `nexus/reason` | deliberate reasoning | anthropic | openai → owned → gemini → venice | — |
| `nexus/code` | codegen/refactor | openai | owned → anthropic → venice → ollama | — |
| `nexus/vision` | multimodal understanding | gemini | openai | vision-capable only |
| `nexus/research` | tool-first research | openai | owned → anthropic → openrouter → gemini | tool-capable only |
| `nexus/deep` | parallel analysis + lead synthesis | anthropic | openai → owned → venice → gemini → openrouter | fan-out pattern |
| `nexus/private` | local-only inference | ollama | *(none)* | local-only, never leaves device |
| `nexus/cheapest` | minimum-cost adequate answer | registry cheapest healthy | next-cheapest… | cost-aware ordering |

Notes: this table preserves atlas-mountain's capability *semantics* under
cleaned names and adds the missing `cheapest` route as data. The legacy
`hetzner/chat`-without-adapter failure mode is impossible by construction:
boot validates every id in this table against registered adapters (§5).

## 3. Router guarantees

1. **Deterministic resolution.** Same target + same registry snapshot ⇒ same
   intent. No hidden state, no time-of-day behaviour.
2. **Single normalization.** All aliases die at ingress; downstream sees only
   canonical ids. Unknown targets are named errors listing valid targets.
3. **Unhealthy exclusion.** Providers the registry marks unusable (unhealthy,
   cooled-down, unauthenticated, missing) are excluded from chains *before*
   ordering; exclusion reasons are recorded in the intent's `attempted` trail.
4. **Constraint enforcement.** `local-only` filters to device providers;
   `vision-capable` / `tool-capable` filter by adapter-declared capabilities;
   `cheapest` orders by registry cost data. Constraints are filters, not
   prompt hints.
5. **Boot validation.** Unresolvable primaries/fallbacks refuse boot with a
   named error (`unknown-route`, `no-adapter`, `empty-chain`). No silent
   degradation to an unrelated vendor.
6. **Budget attachment.** Context/token limits and idle budgets are computed at
   handoff and travel with the intent; the broker enforces them.

## 4. Broker guarantees

1. **Explicit provider routing.** A request naming provider P executes on P or
   fails with a named error (`provider-unavailable`, `not-configured`,
   `constraint-violation`). Silent substitution is a contract violation.
2. **Failover (pre-commit only).** Bounded transient retries then chain
   failover per the error taxonomy (retryable: timeout/unavailable/abrupt-end;
   terminal: invalid-request/context-length/cancelled). Tool-call outputs are
   buffered until the provider stream completes successfully.
3. **No double-answer.** Once visible output (or any committed side effect) has
   been emitted for an attempt, the broker never retries or switches providers
   for that attempt; the original failure surfaces.
4. **Tool requirements.** Tool-capable capabilities only resolve to
   tool-supporting adapters; a tool call to an unregistered/unauthorized tool
   fails closed; every executed tool call is permission-checked (with durable
   human suspension) and recorded with its decision.
5. **Context limits.** Oversized context fails *before* spend with a named
   error and a shrinkage hint (what exceeded, by how much); truncation is never
   silent.
6. **Trace linkage.** Every attempt, tool call, failover and job event carries
   the intent's correlation id.

## 5. Registry guarantees

- Four-state health (`healthy / configured / authentication_failure /
  unavailable`) with reasons and timestamps; concurrent probing with TTLs so
  checks cost O(slowest), not O(sum).
- Cooldowns from broker failure reports; performance ledger durable and
  shared; cost data per provider for `cheapest`.
- `register(adapter)` / `deregister(id)` with capability revalidation on
  change; registry change events so Nexus snapshots stay fresh.

## 6. Contract cases (acceptance)

These are the cases the scaffold in `tests/nexus-contract/` encodes and the
real implementation must pass. Each case is independent and deterministic
(no network, no credentials — all doubles).

1. **fast route.** Intent for a trivial prompt resolves to the `nexus/fast`
   chain with the owned pod first when healthy; cloud fallback order otherwise.
2. **reason route.** Deliberative prompt resolves to `nexus/reason` with
   anthropic primary; policy includes the reasoning tool filter.
3. **code route.** Codegen prompt resolves to `nexus/code` with openai primary.
4. **vision route.** Image/document input resolves to `nexus/vision`; chains
   containing non-vision adapters are rejected at resolution, not at call time.
5. **Explicit provider routing.** Naming provider P yields P; with P
   deregistered the router returns a named error (never a silent substitute).
6. **Unhealthy exclusion.** A cooled-down or auth-failed primary is excluded
   with its reason recorded in `attempted`; resolution uses the next healthy
   candidate and marks `usedFallback`.
7. **Failover.** A provider failing pre-output with a retryable error is
   retried within bounds then replaced by the next chain candidate; terminal
   errors advance immediately without retry.
8. **No double-answer on partial streams.** A provider emitting visible text
   then failing surfaces the original failure; no second provider is tried for
   that attempt; buffered (uncommitted) tool calls from the failed attempt are
   discarded, never executed.
9. **Tool requirements.** A `tool-capable` capability never resolves to a
   non-tool adapter; executing an unregistered tool id fails closed; every
   execution carries its permission decision.
10. **Context limits.** Over-budget input is rejected pre-spend with a named
    error + shrinkage hint; at-budget input passes with the budget attached.
11. **Local-only.** `nexus/private` resolves exclusively to device providers;
    with no local provider available it fails closed (named error), never
    escapes to cloud — even under failover.
12. **Cheapest.** With cost data present, `nexus/cheapest` orders healthy
    candidates by cost; without cost data it degrades to the `fast` order and
    records the degradation reason.

## 7. Error taxonomy (shared, stable)

Named errors are part of the contract: `unknown-target`, `unknown-route`,
`no-adapter`, `empty-chain`, `provider-unavailable`, `not-configured`,
`authentication-failure`, `constraint-violation`, `context-exceeded`,
`tool-not-found`, `tool-denied`, `permission-suspended` (not an error — a
durable wait state), `budget-exceeded`, `cancelled`. Codes are stable across
versions; messages are human-readable and may change.

## 8. Conformance strategy

- `tests/nexus-contract/` runs dependency-free (`node --test`) against
  interface doubles today and against the real Nexus/broker tomorrow: the
  scaffold defines the *cases*; implementation PRs swap doubles for real
  modules without changing case names or expectations.
- Routing-intent heuristics (the successor to keyword auto-routing) additionally
  pass through `packages/eval` baselines before they may influence resolution.
