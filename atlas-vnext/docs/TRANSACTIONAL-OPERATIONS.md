# Transactional operations

Design-gate rules for later durable implementations. Do not add side-effecting APIs that are unsafe to retry.

1. **Idempotency keys** on job enqueue and on promote/restore (Caspa `jobQueueService` already does this for jobs — **KEEP BEHAVIOUR**).
2. **Explicit state transitions** — see `JOB_TRANSITIONS` in `platform/jobs`. Illegal transitions throw.
3. **Transactional outbox** (`outboxRecordSchema`) for events that must not be lost if the process dies between commit and SSE publish. Not Kafka.
4. **Atomic writes** for metadata (PostgreSQL transaction) and for CAS (write temp + hash-verify + rename / content-address put).
5. **Rollback** of metadata transactions; CAS objects are immutable so “rollback” means pointing the manifest pointer back.
6. **Retry safety** — execution may retry a candidate only **before** visible assistant output; tool calls are buffered until the stream completes to prevent duplicate side effects.
7. **Audit / provenance** rows are append-only.

Unsafe-to-retry examples we will not port: “promote production” without an idempotency key; “run who()” as an in-request side effect with no job id.
