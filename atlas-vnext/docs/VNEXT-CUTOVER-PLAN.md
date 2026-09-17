# Atlas vNext production cutover plan

Status: planning only. No production cutover is authorised by this document.

Accepted development baseline: `0af67f19f2349a7ac4430364165af254caf4aa96`.

The release candidate must be the exact SHA of the release-closeout commit that is green on GitHub CI after Privacy package-boundary folding, Workbench stored-policy bind, and migration 008 rehearsal. Record that SHA in `VNEXT-RELEASE-VALIDATION.md` before any cutover window.

## Objective

Promote an explicitly approved Atlas vNext release to production without changing protected architecture contracts, losing persisted data, widening Authority, or creating an unrecoverable migration state.

## Release candidate

The final release candidate must be a specific commit derived from the accepted vNext baseline. Any code changes made after the accepted baseline require fresh CI and release validation on the exact candidate SHA.

## Pre-cutover checklist

- Exact candidate SHA recorded.
- GitHub CI green on exact SHA.
- Live browser acceptance complete in non-production.
- Migration 008 rehearsal complete on disposable pre-vNext database.
- Backup freshness confirmed.
- Restore procedure checked.
- Environment/config validation complete.
- Required secrets/config present without exposing values in logs.
- Monitoring and alerting available.
- Rollback decision owner named.
- Release communication window agreed if required.

## Proposed execution order

1. Freeze the release candidate and stop unrelated merges for the cutover window.
2. Take/verify the production backup required by `BACKUP-AND-RECOVERY.md`.
3. Record the current production application/image/version and database schema state.
4. Validate production configuration using the existing production-readiness/config gates.
5. Deploy application components using the repository's documented deployment mechanism, but do not direct user traffic until health checks pass where the platform permits staged activation.
6. Apply migration 008 exactly once through the supported migration path.
7. Verify migration state and application startup.
8. Run read-only smoke checks first: health, auth/session, project/file retrieval, context retrieval, dungeon catalogue, owner privacy access/denial.
9. Run low-risk write smoke checks using designated test data: create a project/file or equivalent disposable object, Caspa draft/revision flow, and provenance check.
10. Verify Nexus/Execution/Authority boundaries through observable application behaviour and automated production-safe checks where available.
11. Enable/continue production traffic only after all mandatory smoke checks pass.
12. Observe error rate, latency, failed jobs, policy denials, database errors, and provider/execution failures during the initial monitoring window.
13. Close the cutover only after the acceptance owner records success.

## Mandatory smoke checks

### Platform

- health endpoint/process ready;
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
- uncertain side effects are not blindly retried.

### Authority / Privacy

- owner can reach owner-only Privacy controls;
- non-owner receives generic denial/404 behaviour as designed;
- model proposal cannot grant Authority;
- effective-policy overlay can restrict but not widen Authority;
- network/autonomy/repo-write restrictions behave as configured.

### Dungeons

- Caspa generate/revise/persist/version/provenance path;
- OSINT public lookup path where policy permits;
- investigation consumes OSINT findings by id;
- research synthesis with citations;
- website preview remains sandboxed;
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
- severe error-rate or availability regression;
- inability to complete core Caspa/Workbench flows;
- any new security regression affecting owner-only controls or tenant isolation.

## Rollback strategy

Prefer application rollback to the last known production version when schema compatibility permits. For database state, follow the tested backup/restore procedure rather than improvising a destructive reverse migration. If migration 008 is additive and backward-compatible, application rollback may be possible without database restore; this must be confirmed during migration rehearsal rather than assumed.

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
- migration result;
- smoke-test results;
- observed alerts/errors;
- rollback not required / rollback details;
- release owner acceptance.

Do not treat this document itself as permission to execute production changes.
