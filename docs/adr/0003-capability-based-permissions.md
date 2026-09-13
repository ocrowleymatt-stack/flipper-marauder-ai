# ADR 0003 — Capability-based permissions at one choke point

## Status

Accepted (design gate).

## Context

Mountain enforces policy in a permission engine, tool-registry guest
denylists, mode filters, and prompt-level posture — simultaneously.
Caspa uses Authentik groups and a proxy secret at nginx, which is
correct for the **edge**. Commons `@ocrowley/policy` is still
role-based (`release-manager`). Life-os Themis is an approval gate on
actions.

The behavioural gem is Mountain’s **pending-permissions suspension**:
the loop waits for a human instead of auto-allowing.

## Decision

1. Broker `execute` / `enqueue` requires `capabilities[]` matching
   the JSON Schema. Role and group fields are forbidden on that object.
2. Edge (Authentik, native login, device pairing) **issues** attenuated
   capabilities.
3. Missing capability → job/turn enters `suspended` and emits
   `capability.suspended`. A human grant resumes. Default deny.
4. Plugins receive only the capabilities they need; they cannot mint
   broader grants.
5. Architecture tests inspect schemas and broker signatures for role
   checks and scan product code for `roles.includes` at the broker
   boundary.

## Consequences

- Tenancy and guest access become caveats (project scope, expiry,
  local-only, no-exfil), not parallel denylist code.
- Caspa/Authentik keep working as issuers.
- Themis-style production writes are capability actions
  (`deploy.promote`) issued only after evidence gates, not a second
  policy language inside Nexus.
