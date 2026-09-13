# Contracts

Language-agnostic **JSON Schema** in `packages/contracts/schemas/` is the
source of truth. TypeScript types in `packages/contracts/src/` must match.
A later gate may add protobuf; do not fork shapes per language.

All resource ids are ULID-shaped strings unless noted. Timestamps are
RFC 3339 UTC.

## Content addresses

```text
cas:sha256:[0-9a-f]{64}
```

No other storage locator is legal at a package boundary. See
`storage-address.schema.json`.

## Capability tokens

A capability is a signed, attenuable grant — not a role string.

Minimum fields: `id`, `issuer`, `subject`, `action`, `resource`,
`notBefore`, `expiresAt`, `caveats[]`, `proof`.

Broker `execute` **requires** `capabilities: Capability[]`. Role,
group, and Authentik fields are **forbidden** on that request object
(enforced by schema `additionalProperties` + boundary tests).

## Execution intent (Nexus → Broker)

Nexus output, broker input:

| Field | Meaning |
|---|---|
| `correlationId` | Joins route → attempts → tools → events |
| `projectId` | Tenancy / retrieval unit |
| `capabilityId` | Canonical, e.g. `nexus/reason` |
| `chain` | Ordered provider ids (no adapters) |
| `policy` | localOnly, budgets, retrieval, posture |
| `input` | Message / job payload reference (CAS or inline small text) |
| `capabilities` | Caller’s grants (pass-through) |

Nexus does not include retry counts, tool implementations, or provider
credentials.

## Jobs

States: `queued | leased | running | suspended | completed | failed | cancelled`.

Enqueue requires `idempotencyKey`. `checkpoint` if present is a
`ContentAddress`. Domain payload is a CAS address or a small JSON object
validated by the plugin — never an untyped blob column as the API.

## Projects

A project is `{ id, tenantId, name, createdAt, settings }` where
`settings` is a **schema-versioned** object (`settingsSchemaVersion`),
not an opaque junk drawer. Conversations, jobs, links, and grants
reference `projectId`.

## Events

```text
{ id, sequence, occurredAt, correlationId, projectId, jobId?, type, payload, provenance? }
```

`type` is namespaced (`job.progress`, `nexus.resolved`,
`capability.suspended`, `storage.linked`, `osint.finding`, …).
Evidential events **must** include provenance.

## Provenance

```text
{
  source,              // URI, tool id, or human
  retrievedAt,
  method,              // http, tool, model, human, cas
  evidentialStatus,    // primary | secondary | intelligence_lead | derived | unavailable
  contentAddress?,     // if bytes were stored
  digest?
}
```

## HTTP surface (edge)

OpenAPI stub: `packages/contracts/openapi/vnext.yaml`.

Minimum paths (later gates fill implementations):

- `POST /v1/intents` — create execution intent (Nexus)
- `POST /v1/jobs` — enqueue
- `GET /v1/jobs/{id}` — snapshot (not a poll loop; prefer events)
- `GET /v1/projects/{id}/events` — SSE replay from `Last-Event-ID`
- `POST /v1/storage` — put bytes, returns content address
- `GET /v1/storage/{address}` — get bytes
- `POST /v1/capabilities/grants` — human grant (edge → issuer)
- `GET /health` — liveness
- `GET /v1/doctor` — sanitised readiness (no secrets)

## Python / mixed stack

Life-os kernels stay out of Nexus. If Python workers appear, they
consume the **same JSON schemas** (compute, quantum compile, music DSP)
via the broker, never via dungeon-to-dungeon calls.
