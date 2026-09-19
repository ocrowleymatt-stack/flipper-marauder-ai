# Atlas vNext release validation

**Public baseline (accepted):** `68603a465f39ff20804f221b5db6e3faf1cdfb11`  
See [release/PUBLIC-VNEXT-BASELINE.md](./release/PUBLIC-VNEXT-BASELINE.md). Exact-main CI [35424604752](https://github.com/ocrowleymatt-stack/flipper-marauder-ai/actions/runs/35424604752) SUCCESS. Production build `production-68603a4-20260919T0552Z`. Public origin `https://atlas.ocrowley.com`.

The remainder of this document is the pre-cutover development freeze. It is historical context, not the public SHA.

Accepted development baseline: `0af67f19f2349a7ac4430364165af254caf4aa96`

Status: **SUPERSEDED FOR PUBLIC TRAFFIC** by `68603a4`. Production cutover of vNext native login was a later explicit operation; visible-output recovery then became the first accepted public application SHA.

Release candidate (immutable for the cutover window): `757b77a9518ccbd595d1d3a3698915f3a94b045c`


Exact-head GitHub CI: workflow run `35174760899` (`verify` SUCCESS) on that SHA.

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

Recorded **green** against the non-production mock host at `http://127.0.0.1:5173/` (memory persistence, `ATLAS_USE_MOCK_PROVIDERS=1`) on 2026-09-17.

Walkthrough video confirms: session boot, project create, CAS file upload, Workbench chat completion, Caspa generate/commit, OSINT scan → investigation/research, Website Studio with promote blocked while `repoWrite` is false, owner Privacy & Safety panel, and 390×844 navigation.

A follow-up live pass confirmed the Sound off → Sound on → Sound off control and Command palette open/close. Reduced-motion follows `prefers-reduced-motion` CSS and was not OS-toggled in this pass. Forced cancellation and tool-approval UI were not re-driven in the browser (covered by host Workbench/tools tests).

### 2. Migration 008 rehearsal

Apply migration 008 on a disposable database representing the currently supported pre-vNext schema. Verify:

- upgrade succeeds once;
- repeated startup is idempotent;
- rollback/restoration procedure is documented and tested from backup rather than by destructive down-migration unless explicitly supported;
- no existing Projects/Files/CAS/context/provenance rows are mutated unexpectedly;
- estate/privacy metadata defaults are correct.

**Disposition: green (automated).** `platform/persistence/tests/postgres/migrate.test.ts` rehearses a disposable schema at v7 with seeded Projects/Files/CAS/context/provenance/conversation/document rows, applies `008` once, asserts those rows are byte-stable, asserts estate/privacy tables exist empty, then re-runs migrate (all versions skipped). Rollback remains backup/restore per `BACKUP-AND-RECOVERY.md`; there is no destructive down-migration.

### 3. Production-readiness delta review

Review only the vNext delta against the already-accepted Production Readiness baseline. Confirm deployment configuration, environment validation, observability, backup/restore, and rollback assumptions still hold after migration 008, dungeon estate, Caspa restoration, Privacy, effective-policy overlays, and Workbench changes.

**Disposition: hold.** The PR #11 Production Readiness contract is unchanged:

- production still requires PostgreSQL, tenant id, session secret, explicit origins, and CAS root;
- mock providers and the JSON file store remain forbidden in production;
- topology remains enforced single-instance (`ha: false`);
- migrations remain forward-only and checksummed; `008` is additive and does not rewrite durable project/file/CAS/context/provenance rows;
- backup/restore remains `pg_dump` + CAS copy to a new cluster, already drilled by `tests/production/restore.test.ts`;
- observability, redaction, kill switches, and production config validation are unchanged by Workbench presentation or dungeon estate HTTP;
- historical `PRODUCTION.md` cutover verdict remains **NO-GO** because DNS/secret/traffic switch is a separate human operation.

No production-readiness row is silently promoted from CONDITIONAL to PASS.

### 4. Residual-debt disposition

| Item | Disposition | Rationale |
|---|---|---|
| architecture package analysis omits `dungeons/privacy/package.json` | **fixed before production** | Privacy is in the shared `analyzePackageJson` dungeon list and uses authoritative `TRANSPORT_MODULES`. PR #17's duplicate guard is superseded. |
| generic Workbench chat does not bind stored `toolsEnabled` / `processing` | **fixed before production** | Host conversation send overlays the stored tenant EffectivePolicy. Client `tools: true` cannot enable tools when policy disables them; `processing=local_only` forces Nexus local-only routing. Viewing policy remains owner-only. |
| stored `modelProvidersAllowed` / `modelProvidersDenied` are not yet enforced by Nexus routing | **accepted post-release** | D4 keeps policy as an overlay after Authority, not a Nexus grant/filter plane. Binding named provider lists would require a new Nexus request-constraint port and risks leaking provider detail into generic UI contracts. `processing=local_only` and provider kill switches already constrain routing. |
| `private_cloud` has no dedicated Nexus target | **accepted post-release** | Catalogue Forge/RunPod entries remain `privacyEligibility: any`. `local_only` already excludes public cloud. A dedicated private-cloud locality target is new routing product work, not a vNext contract hole. |
| `proposedByModel` is a client flag; owner principal remains the real gate | **accepted post-release** | `proposedByModel: true` is denied 404. Owner principal + Authority `privacy.configure` remain the grant path. Pending OIDC does not weaken this. |
| step-up uses the `CONFIRM` phrase pending OIDC | **accepted post-release** | D6. CSRF + explicit phrase + audit until password/OIDC step-up exists. |
| embeddings remain deferred in favour of lexical context | **accepted post-release** | Production Readiness already accepted lexical retrieval. Not a cutover blocker. |

## Release candidate

Frozen SHA: `757b77a9518ccbd595d1d3a3698915f3a94b045c`  
Branch: `cursor/vnext-release-closeout-8149`  
GitHub CI: https://github.com/ocrowleymatt-stack/flipper-marauder-ai/actions/runs/35174760899 (`verify` SUCCESS on that exact commit)

This SHA is the release-closeout of accepted baseline `0af67f1` plus:

- Privacy package.json folded into shared `analyzePackageJson` (supersedes #17);
- stored EffectivePolicy bound to generic Workbench chat;
- migration 008 rehearsal from disposable pre-vNext schema;
- residual-debt disposition and production-readiness delta.

A later documentation commit may *name* this SHA; cutover must still deploy this code SHA or a later commit whose CI is also green and whose tree includes these fixes.

Production cutover is **not** authorised by freezing a candidate.

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
