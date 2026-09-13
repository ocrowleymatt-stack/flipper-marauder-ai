# ADR 0001 — Split Nexus router from the execution broker

## Status

Accepted (design gate).

## Context

Atlas Mountain’s Nexus process composes routing, failover, cooldowns,
performance ranking, tool execution, dungeon logic, job runners, and
even HTTP preview serving. Caspa independently grew a full failover
router plus a loopback client to Mountain’s recovery fabric. The result
is a god-object: capability resolution cannot be tested without spinning
side effects, and domains cannot be isolated.

vNext requires a deliberately small Nexus and a separate execution
broker.

## Decision

1. **Nexus** resolves `(target, context) → ExecutionIntent`. It may
   read a registry snapshot. It may not call providers, tools, or job
   stores. Production source stays under a CI line budget.
2. **Broker** is the only side-effecting core: adapters, tools, jobs,
   CAS writes, event append, capability enforcement.
3. The handoff type is `ExecutionIntent` in `@atlas-vnext/contracts`.
   Any other path from HTTP handler to a vendor SDK is a failed
   architecture test (“broker bypass”).

## Consequences

- Failover, billing quarantine, and streaming live in the broker, so
  Caspa and future consumers share one contract.
- Nexus can be reasoned about and eval-gated as a pure table + policy
  assembler.
- Specialists who want “just add a retry in the router” must change the
  broker instead; CI will reject retries in `services/nexus`.
