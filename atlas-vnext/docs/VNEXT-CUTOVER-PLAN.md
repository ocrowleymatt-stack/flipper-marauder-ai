# Atlas vNext production cutover plan

Status: planning only. No production cutover is authorised by this document.

Accepted development baseline: `09b8c2d11312bc8b48b296cfdb85ed5587667814`.
Production-readiness candidate: the exact head of `cursor/vnext-production-readiness` once CI is green.

Public production remains frozen at `68603a465f39ff20804f221b5db6e3faf1cdfb11` until Owner authorization.

## Objective

Promote an explicitly approved Atlas vNext release to production without changing protected architecture contracts, losing persisted data, widening Authority, installing ACE-Step, or retargeting the LLM RunPod.

## Release candidate

The final release candidate must be a specific commit derived from the accepted Wave 6 baseline. Schema remains v9 (`001`–`009`). Waves 1–6 added no SQL.

## Pre-cutover checklist

- Exact candidate SHA recorded.
- GitHub CI green on exact SHA, including production gates, cutover preflight, and browser acceptance.
- Live browser acceptance complete in non-production: Conversation, Projects/Library, Research, OSINT, Writing, Website, Music, native login, 390px.
- Schema v9 identity confirmed against freeze `68603a4`; no reverse migration required.
- Backup freshness confirmed (`pg_dump` + CAS copy).
- Restore procedure checked on a **new** cluster.
- Environment/config validation complete; Music GPU / ACE-Step env absent.
- Required secrets/config present without exposing values in logs.
- Monitoring and alerting available.
- Rollback decision owner named.
- Release communication window agreed if required.

## Proposed execution order

1. Freeze the release candidate and stop unrelated merges for the cutover window.
2. Take/verify the production backup required by `BACKUP-AND-RECOVERY.md`.
3. Record the current production application/image/version and database schema state (`68603a4`, schema v9).
4. Validate production configuration using `npm run cutover:preflight -- --production`.
5. Deploy application components using the repository's documented deployment mechanism, but do not direct user traffic until health checks pass where the platform permits staged activation.
6. Apply migrations through the supported path. On a freeze-era v9 database this is a no-op (all versions skipped).
7. Verify migration state and application startup. `/api/health/live` 200; `/api/health/ready` 200; `ha: false`.
8. Run read-only smoke checks first: health, native login (bootstrap remains 401), project/file retrieval, context retrieval, dungeon catalogue, owner privacy access/denial.
9. Run low-risk write smoke checks using designated test data: create a project/file, Caspa draft/revision, Website generate, Music compose + authenticated audition, Research, OSINT, provenance check.
10. Verify Nexus/Execution/Authority boundaries through observable application behaviour and automated production-safe checks where available.
11. Enable/continue production traffic only after all mandatory smoke checks pass **and Owner authorization**.
12. Observe error rate, latency, failed jobs, policy denials, database errors, and provider/execution failures during the initial monitoring window.
13. Close the cutover only after the acceptance owner records success.

## Mandatory smoke checks

### Platform

- health endpoint/process ready;
- native login works; `POST /api/session` bootstrap is 401;
- server-derived tenant identity works;
- spoofed client tenant identity is not accepted;
- Projects/Files/CAS/context retrieval works;
- provenance persists;
- jobs/events execute without queue/backing-store errors.

### Nexus / Execution

- generic request routes through Nexus aliasing;
- provider-specific detail does not leak into generic UI contracts;
- execution failures are classified correctly;
- no provider failover after visible output;
- uncertain side effects are not blindly retried;
- RunPod remains LLM-only; ACE-Step remains absent.

### Authority / Privacy

- owner can reach owner-only Privacy controls;
- non-owner receives generic denial/404 behaviour as designed;
- model proposal cannot grant Authority;
- effective-policy overlay can restrict but not widen Authority;
- network/autonomy/repo-write restrictions behave as configured.

### Dungeons

- Caspa generate/revise/persist/version/provenance path;
- OSINT public lookup path where policy permits;
- research synthesis with citations;
- website preview remains sandboxed;
- music score → MIDI/WAV on the host; audition/midi streams require a session;
- music path routes through Nexus rather than vendor-specific dungeon logic.

### Workbench

- streaming remains functional;
- cancel works;
- approval/error/tool states remain visible;
- sound remains off by default;
- reduced-motion preference is respected;
- narrow/mobile viewport remains usable.

## Rollback triggers

Rollback should be initiated if any of the following cannot be rapidly contained:

- migration failure or inconsistent schema state;
- authentication/tenant derivation failure;
- Authority bypass or privacy exposure;
- persistent corruption/loss of Projects, Files, CAS, context, or provenance;
- repeated execution of uncertain side effects;
- provider failover after visible output;
- ACE-Step or Music GPU appearing on the LLM host;
- severe error-rate or availability regression;
- inability to complete core Conversation / Caspa / Website / Music flows;
- any new security regression affecting owner-only controls or tenant isolation.

## Rollback strategy

Prefer application rollback to `68603a465f39ff20804f221b5db6e3faf1cdfb11` when schema compatibility permits. Schema is still v9, so application rollback does **not** require a reverse migration. For database state, follow the tested backup/restore procedure rather than improvising a destructive reverse migration.

After rollback:

- stop further release changes;
- capture logs/metrics and exact failure point;
- confirm service and data integrity on the restored state;
- open a defect with reproduction evidence;
- require a new release candidate and fresh validation before retrying.

## Completion record

At cutover completion record:

- deployed SHA;
- deployment start/end time;
- migration result (expected: all v9 skipped);
- smoke-test results;
- observed alerts/errors;
- rollback not required / rollback details;
- release owner acceptance.

Do not treat this document itself as permission to execute production changes.
