# Atlas vNext release validation

Accepted development baseline: `0af67f19f2349a7ac4430364165af254caf4aa96`

Status: development baseline accepted; production cutover not authorised or performed.

## Integration evidence

The vNext stack landed on `main` by ordered fast-forward:

1. `cursor/vnext-platform-seams-8149` → `2d05bbc8448f8922c73cd782a670e92996cda1e7`
2. `cursor/vnext-caspa-estate-8149` → `20586dededb73eab0e340db51080108559a3bc58`
3. `cursor/vnext-workbench-experience-8149` → `0af67f19f2349a7ac4430364165af254caf4aa96`

The final integrated push ran CI as workflow run `35169829111` and completed successfully.

Passing CI stages on the final `main` head include install, lint, typecheck, unit tests, PostgreSQL persistence, Files/Projects/CAS/context, tools/auth/Authority, Caspa, dungeon estate, production-readiness gates, production-config contract, HA-topology refusal, dependency-advisory classification, architecture boundaries, provider/runtime tests, Mountain behavioural compatibility, and build.

## Protected-contract acceptance

The accepted baseline preserves these contracts:

- Nexus owns provider/model/routing decisions.
- Execution owns transports, retry/failover, and execution-failure classification.
- Provider failover is not permitted after visible output.
- Behaviour and Authority remain separate.
- Authority and tenant enforcement remain server-side.
- Tenant identity remains server-derived.
- Dungeons remain thin consumers of platform capabilities.
- Provider/RunPod implementation detail does not leak into generic UI, Behaviour, Nexus, or Dungeon contracts.
- Tool side effects with uncertain completion remain reconciliation-required rather than blindly retried.
- Existing persistence semantics remain intact.
- Projects/Files/CAS/context/retrieval/provenance remain shared platform capabilities.
- Privacy remains owner-only and model self-grant / tenant-header spoofing are denied.

## Product acceptance already evidenced

- Caspa is restored as an Atlas-native writing dungeon using shared persistence, jobs, Files, context, Nexus, Execution, and provenance.
- Specialist dungeon estate includes writing/Caspa, OSINT, investigation, research, website, music, and privacy.
- Effective-policy overlays apply to dungeon runs and cannot grant beyond Authority.
- Workbench presentation changes are confined to presentation/experience concerns and do not own platform semantics.
- Host integration tests cover the specialist-dungeon path and policy-denial cases.

## Remaining release-validation gates

These are the remaining checks before any production cutover decision.

### 1. Live browser acceptance

Run a browser-based acceptance pass against a non-production environment and record pass/fail evidence for:

- authentication/session boot;
- project and file selection;
- Workbench chat and streaming output;
- Caspa create/edit/revise/complete-draft flows;
- dungeon switching;
- OSINT → investigation → research handoff;
- website preview and promotion controls;
- privacy owner-only routes and denial behaviour;
- reduced-motion behaviour;
- sound default-off and explicit enable control;
- approval/error/tool cues;
- cancellation and failure recovery;
- mobile/narrow viewport smoke check.

Do not use production traffic or data for this gate.

### 2. Migration 008 rehearsal

Apply migration 008 on a disposable database representing the currently supported pre-vNext schema. Verify:

- upgrade succeeds once;
- repeated startup is idempotent;
- rollback/restoration procedure is documented and tested from backup rather than by destructive down-migration unless explicitly supported;
- no existing Projects/Files/CAS/context/provenance rows are mutated unexpectedly;
- estate/privacy metadata defaults are correct.

### 3. Production-readiness delta review

Review only the vNext delta against the already-accepted Production Readiness baseline. Confirm deployment configuration, environment validation, observability, backup/restore, and rollback assumptions still hold after migration 008, dungeon estate, Caspa restoration, Privacy, effective-policy overlays, and Workbench changes.

### 4. Residual-debt disposition

Each item below must be marked either `fix before production` or `accepted post-release` with rationale:

- stored `modelProvidersAllowed` / `modelProvidersDenied` are not yet enforced by Nexus routing;
- generic Workbench chat does not bind every stored Privacy field;
- `private_cloud` has no dedicated Nexus target;
- `proposedByModel` is a client flag; owner principal remains the real gate;
- step-up uses the `CONFIRM` phrase pending OIDC;
- embeddings remain deferred in favour of lexical context;
- architecture package analysis omits `dungeons/privacy/package.json` although current dependencies are clean.

## Production cutover preconditions

Production cutover must remain a separate explicit operation. Before it begins, all of the following must be true:

- final release commit is named and immutable for the cutover window;
- CI is green on that exact commit;
- browser acceptance is recorded green or accepted exceptions are documented;
- migration rehearsal is green;
- backup and restore procedure has been checked against the target environment;
- rollback trigger, owner, and procedure are written down;
- environment/config validation is green;
- smoke-test commands and success criteria are written down;
- monitoring/alerting expectations for the first production window are defined;
- no unresolved release blocker remains.

## Cutover boundary

This document does not authorise production traffic changes, DNS changes, production infrastructure mutation, production-data migration, or release deployment. Those actions require an explicit production-cutover decision.
