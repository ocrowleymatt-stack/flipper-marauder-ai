# Jobs and events

## Rules

1. Long-running work is a durable `Job`, including OSINT scans and writing commissions.
2. Restarts resume from the last checkpoint.
3. UI progress is SSE/WebSocket. Polling loops are forbidden for active views.
4. Workers hold time-bounded leases.
5. Domain stages are dungeon handlers; the engine is shared.

## States

`queued` → `running` → `completed` | `failed` | `cancelled`  
side states: `waiting_permission`, `paused`.

## Record (contract)

id, projectId, dungeon, type, status, priority, currentStage, progressRatio, checkpoint, retryCount, maxRetries, leaseOwner, leaseUntil, traceId, timestamps.

## Events

`GET /api/jobs/:id/events` (future). Envelope: eventId, channel, type, timestamp, payload.

Types: `job.created|started|stage_transition|progress|checkpoint|permission_requested|completed|failed|cancelled`.

Heartbeat comments keep proxies from dropping the stream.

This PR ships contracts + `platform/jobs` and `platform/events` interfaces. No in-memory fake runner.
