# Jobs and events

## Jobs

A job is the durable unit of long-running work. Dungeons do not invent parallel stores.

```text
Job
  schemaVersion: 1
  id: ObjectId                 type = job
  projectId: ObjectId          required (use a system project for operator tasks)
  type: string                 e.g. writing.commission, osint.who, website.build
  status: queued | running | blocked | completed | cancelled | failed
  progress: { ratio: 0..1, message?: string, phase?: string }
  checkpoint: Json             dungeon-defined, must be resume-safe
  retry: { attempt: number, nextAttemptAt?: datetime, reason?: string }
  cancellation: { requestedAt?: datetime, reason?: string }
  failure?: { code: string, message: string, retryable: boolean, classifiedAs: string }
  lease?: { workerId: string, expiresAt: datetime }
  traceId: string
  parentJobId?: ObjectId
  createdAt, updatedAt, startedAt?, completedAt?
  createdBy: subject id
```

### Status machine

```text
queued → running → completed
                 → failed
                 → blocked → running
                 → cancelled
queued → cancelled
running → queued            (lease expired, checkpoint saved, retry)
```

Illegal: `completed → running` (start a new job). `failed → running` only via explicit retry that increments `retry.attempt`.

### Lease and resume

Workers heartbeat. If `lease.expiresAt` passes, any worker may reclaim. Reclaim **must not** replay completed checkpointed work (Writing Dungeon skill rule).

Cancellation is cooperative: set `cancellation.requestedAt`; workers stop at the next checkpoint and persist `cancelled`.

### Progress

`progress.ratio` is informational. Source of truth for UI is the **event stream**. Ratio may jump backward only after reclaim (document in the event).

## Events

```text
Event
  schemaVersion: 1
  id: ObjectId                 type = event
  traceId
  jobId?: ObjectId
  projectId?: ObjectId
  type                         see catalogue
  ts
  payload                      typed per type
```

### Catalogue (v1)

| type | When | Payload (min) |
|---|---|---|
| `route.resolved` | Nexus returned candidates | alias, candidate ids, exclusions |
| `provider.attempt` | Execution started an adapter | providerId, modelId, attempt |
| `provider.retry` | Same provider, second try | reason |
| `provider.fallback` | Next candidate | from, to, reason |
| `token.delta` | Streamed text | (bytes not stored long-term by default) |
| `job.created` / `job.started` / `job.progress` / `job.blocked` / `job.completed` / `job.failed` / `job.cancelled` | Job lifecycle | status, phase, ratio |
| `permission.asked` / `permission.decided` | Scope prompt | scope, decision |
| `artefact.written` | Blob+manifest committed | digest, objectId |
| `trace.failed` | Terminal error | classification |

Live transport: **SSE** (`text/event-stream`) keyed by `jobId` or `traceId`. WebSocket is an alternative with the same envelopes. HTTP GET of the job record is for reconnection/catch-up, not the primary progress loop.

Catch-up: clients send `Last-Event-ID`. The store replays subsequent events then tails.

## Ownership

- `platform/jobs` — persistence, lease, status machine.
- `platform/events` — append-only log + fan-out.
- Dungeons — checkpoint JSON schema for *their* `job.type`.
- Execution — emits provider/stream events; does not persist jobs unless asked.
- Nexus — emits `route.resolved` only. No job table.

## Failure classification (shared with execution)

`timeout | unavailable | auth_failure | invalid_request | context_length | malformed_response | abrupt_end | cancelled | unknown`

Retryable at transport: `timeout`, `unavailable`, `abrupt_end` (pre-output only).

## Divergence

Atlas Mountain split jobs by dungeon table. Caspa had a user-scoped queue. Commons WHO jobs already had SSE + retry + cancel — closest behavioural match. vNext promotes that shape to the platform and drops per-dungeon tables as sources of truth.
