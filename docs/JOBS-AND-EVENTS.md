# Atlas vNext — Jobs and Events

One durable-job substrate replaces research jobs, investigation runs, writing
headless jobs and device-relayed work. Progress is events, never polled rows.
Census grounding: §§2, 6, 8, 11, 12, 14, 21.

---

## 1. Why one substrate

The census found three job stores, three polling loops and three recovery
stories for a single concept: *durable work that outlives a request*. The
merge target keeps the best of each: investigation's run-contract/recovery
semantics, the research runner's engine fan-out, writing's commission
observability habits — on a single broker-owned implementation.

## 2. Job model

A job is a durable record with:

- **Identity:** `job_id` (idempotency key supplied by the enqueuer; re-enqueue
  with the same key returns the existing job — no duplicate commissions, no
  duplicate investigations).
- **Type + version:** `job_type` (e.g. `research.sweep`, `investigation.run`,
  `writing.commission`, `compute.batch`, `device.task`, `gc.collect`) with a
  handler version. Handlers are plugin-contributed and versioned; old jobs run
  to completion on the version they started with.
- **Scope:** tenant, project, correlation id, enqueuing principal/capabilities.
- **State machine (durable):**
  `queued → leased → running → (suspended:awaiting-permission | awaiting-input)
  → succeeded | failed | cancelled | expired`.
  `suspended` is durable, not in-memory: a broker restart resumes waiting jobs
  instead of losing them (closes the research-runner `AbortController`-map gap).
- **Lease + heartbeat:** workers hold time-bounded leases and heartbeat;
  expired leases return the job to `queued` with an attempt counter (at-least-once
  execution; handlers must be idempotent — enforced by review, aided by the
  idempotency-keyed side-effect log in `tool_executions`).
- **Attempts + recovery policy:** per-type retry budgets, backoff, and terminal
  error classes (reuse the provider `ProviderError`-style taxonomy generalized:
  retryable / terminal / awaiting-human). Recovery semantics graduate from the
  investigation run-recovery design: jobs declare resumability; the broker
  resumes from the last committed checkpoint event, never by re-running blind.
- **Cancellation:** cooperative + enforced: cancel is a durable state with
  lease revocation; handlers observe cancellation tokens and commit a
  `cancelled` checkpoint. Cancel propagates to child jobs and leased compute.

## 3. Permissions inside jobs

- Enqueue requires the capability for the job type **and** its foreseeable
  side effects (declared per handler version).
- Mid-job side effects pass the same broker choke point as interactive calls,
  including human suspension: a commission needing publication approval
  suspends durably until decided — the permission-suspension semantic,
  generalized from the chat loop to background work.
- Guest/tenant capability sets apply identically; no "background bypass".

## 4. Events (not polling)

- Every state transition, heartbeat milestone, progress report, tool outcome
  and artifact publication is an **event** on the durable event log, keyed by
  `(job_id, seq)` and carrying the correlation id.
- Delivery: SSE/WebSocket streams for live clients (replacing the stream
  registry + poll timers), durable replay for reconnects ("give me events since
  seq N"), and subscriptions for cross-domain reactions (e.g. dungeon UI
  progress bars, scheduler triggers).
- The investigation source scheduler's dungeon-owned polling becomes
  **event-driven triggers** (time/interval triggers are broker-owned schedule
  entries producing events, not per-domain timers).
- Exactly-once delivery is not promised; idempotent consumers keyed by
  `(job_id, seq)` are the contract — documented in the plugin SDK.

## 5. Scheduling and pools

- One broker worker pool with **workload classes** (interactive, batch,
  gpu-inference, music, classical-compute, device-relayed) and priorities —
  unifying the compute pool (§6/§10 of boundaries) with job execution.
- Static concurrency caps are replaced by lease-based backpressure: queue
  depth, lease timeouts and per-class budgets are observable and policy data.
- Long-running/continuous work (source sweeps, warm-pod keeping) is modelled
  as **recurring schedule entries** producing jobs, owned by the broker, with
  audit trails — not hidden timers in dungeon modules.

## 6. Fan-out patterns (deep / adversarial / research sweeps)

- Scout/lead synthesis (multimodel deep/adversarial) and engine fan-out
  (research) are **broker patterns over jobs**: fan-out enqueues child jobs
  with the same correlation id, the lead step consumes child result events.
  No bespoke fan-out code per domain; the patterns are tested once, reused
  everywhere.
- Partial failure is normal: child failure policy (fail-fast vs best-effort
  with quorum) is declared per fan-out, and the lead records which children
  contributed — provenance for synthesized answers.

## 7. Relationship to the failover contract

- Provider calls *inside* jobs use the same failover contract as interactive
  calls (transactional tool buffering, no switch after visible text — where
  "visible" generalizes to "committed side effect or emitted answer chunk").
- Job recovery (resume from checkpoint) and provider failover (retry within an
  attempt) are distinct layers with distinct logs; both reference the
  correlation id so an operator sees one story.

## 8. Operability

- Every job is inspectable: state, attempts, lease holder, checkpoints,
  events, cost/latency attribution (feeds the durable perf ledger).
- Administrative operations (retry, cancel, requeue with new params, pause a
  job type) are broker APIs with audit events — replacing one-off repair
  scripts.
- Dead-lettering: jobs exhausting recovery policy land in a dead-letter view
  with full context, not silent terminal rows.

## 9. What we explicitly do not carry over

- Per-domain job tables/poll loops/recovery stories; in-memory-only wait
  states; polling clients; hidden timers; static concurrency caps; headless
  workers as separate processes per dungeon.
