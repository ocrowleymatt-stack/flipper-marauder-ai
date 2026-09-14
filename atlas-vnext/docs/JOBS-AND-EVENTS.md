# Jobs and events

## Rules

1. Long-running work is a durable `Job`, including OSINT scans and writing commissions.
2. Restarts resume from the last checkpoint.
3. UI progress is SSE first. Polling loops are forbidden for active views.
4. Workers hold time-bounded leases.
5. Domain stages are dungeon handlers; the engine is shared.
6. Enqueue is idempotent when `idempotencyKey` is provided.

## States

`queued` → `running` → `completed` | `failed` | `cancelled`  
side states: `waiting`, `waiting_runtime`, `waiting_permission`, `paused`.

Illegal transitions throw (`assertJobTransition`). Failed jobs may return to `queued` for retry; cancelled/completed are terminal.

## Record (contract)

id, projectId, dungeon, type, status, priority, currentStage, progressRatio, checkpoint, retryCount, maxRetries, leaseOwner, leaseUntil, idempotencyKey, traceId, structured `failureReason`, timestamps (`createdAt`, `updatedAt`, `startedAt`, `completedAt`). Each claim is a `job_attempts` row.

## Events

`GET /api/jobs/:id/events` (future). Envelope: eventId, channel, type, timestamp, payload.

Types: `job.created|started|stage_transition|progress|checkpoint|permission_requested|completed|failed|cancelled`.

Heartbeat comments keep proxies from dropping the stream. Durable delivery uses a transactional outbox, not a second broker.

This PR ships contracts, `platform/jobs` (engine + stores), and `platform/events` (replay/idempotent publish). PostgreSQL persistence is in `platform/persistence`.
