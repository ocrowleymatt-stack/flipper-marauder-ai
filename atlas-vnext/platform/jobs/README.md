# @atlas-vnext/jobs

Platform primitive: durable jobs.

Every long-running operation (commission, OSINT scan, research sweep, site build) is a persisted job with status, checkpoints, leases, retries, cancellation, and a trace ID.

This is not a dungeon-specific runner. Dungeons register handlers; the job engine is shared.

This package freezes the interface and the legal state transitions. Durable PostgreSQL persistence is deferred; in-memory maps are not shipped.
