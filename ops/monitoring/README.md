# ops/monitoring

**Status:** placeholder. Not an npm package.

## Intent

Operate on the signals that `@atlas/platform-observability` emits: dashboards, alert rules, model
health checks for Nexus, and job-queue health. Monitoring consumes traces and metrics; it never
produces business events.

## Will contain

- dashboard and alert definitions
- probes and their expected thresholds
- on-call runbooks that reference `traceId`s and `RouteTrace`s

## Must NOT contain

- application code or anything imported by workspace packages
- instrumentation (that lives in `platform/observability`)
