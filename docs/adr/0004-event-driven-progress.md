# ADR 0004 — Event-driven progress with at-least-once delivery

## Status

Accepted (design gate).

## Context

Mountain polls job rows (research timers, investigation executors,
headless writers). Caspa and `@ocrowley/jobs` already stream job
progress over SSE. Commons OSINT `who()` jobs expose
`/api/who/jobs/:id/events`. Polling duplicates recovery logic per
domain and loses history on restart.

## Decision

1. Every job state change, route resolution, provider attempt, tool
   result, and human gate is an append-only event with a monotonic
   `sequence` per project (or global with project index).
2. Clients subscribe (`GET /v1/projects/{id}/events`) and replay from
   `Last-Event-ID`. REST job GET is a snapshot, not the progress API.
3. Delivery is **at-least-once**. Consumers idempotently key on
   `event.id`. No exactly-once claim.
4. Correlation id is mandatory and joins Nexus resolution to broker
   attempts.

## Consequences

- Domain UIs become event renderers.
- Broker restart mid-job is recoverable from events + CAS checkpoints.
- Evaluation and observability are the same stream, not a side channel.
