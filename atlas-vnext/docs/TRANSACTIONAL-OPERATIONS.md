# Transactional operations

Design-gate rules now implemented for metadata in `platform/persistence` (see [PERSISTENCE.md](./PERSISTENCE.md)). Do not add side-effecting APIs that are unsafe to retry.

1. **Idempotency keys** on conversation create, message append, job enqueue, job checkpoint, and event append. Duplicate execution create (same user message) and duplicate terminal completion reuse the committed row.
2. **Explicit state transitions** — see `JOB_TRANSITIONS` in `platform/jobs`. Illegal transitions throw. Terminal job states are immutable except admin recovery. Repeated `complete`/`fail`/`cancel` is a no-op.
3. **Durable event log** committed in the same transaction as the state change; SSE fan-out is after commit. Reconnect replays from `eventId`/`seq`.
4. **Atomic writes** for conversation/message/execution groups and job+checkpoint+event via `PlatformPersistence.run()`.
5. **Rollback** of metadata transactions on error. CAS is out of this tranche.
6. **Retry safety** — execution may retry a candidate only **before** visible assistant output; tool calls are buffered until the stream completes. Uncertain HTTP retries are safe when the caller resubmits the same idempotency key.
7. **Audit / provenance** rows are append-only metadata (no blobs). `job_attempts` records each claim.
