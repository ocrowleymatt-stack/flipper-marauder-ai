# @atlas-vnext/jobs

Platform primitive: durable jobs.

Every long-running operation (commission, OSINT scan, research sweep, site build) is a persisted job with status, checkpoints, leases, retries, cancellation, and a trace ID.

This is not a dungeon-specific runner. Dungeons register handlers; the job engine is shared.

This package is a design-gate shell. In-memory maps are not a substitute for the durable store and are not shipped here.
