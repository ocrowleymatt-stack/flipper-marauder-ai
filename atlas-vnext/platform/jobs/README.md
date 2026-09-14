# @atlas-vnext/jobs

Platform primitive: durable jobs.

Every long-running operation (commission, OSINT scan, research sweep, site build) is a persisted job with status, checkpoints, leases, retries, cancellation, and a trace ID. Jobs are workspace-scoped platform work, not conversation children and not chat-turn `executions`.

This is not a dungeon-specific runner. Dungeons register handlers; the job engine is shared.

This package freezes the interface, the legal state transitions, and a restart-safe engine (`createJobEngine`) over a `JobStore`. PostgreSQL claiming uses `SELECT … FOR UPDATE SKIP LOCKED`. In-memory is the same engine for unit tests. Terminal states are immutable except explicit admin recovery. `waiting_runtime` is not auto-failed on lease expiry. Each claim records a `job_attempts` row.
