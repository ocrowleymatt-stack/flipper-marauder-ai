# Production readiness — Wave 6 baseline

**DO NOT MERGE AS CUTOVER. DO NOT DEPLOY. DO NOT CHANGE DNS OR PRODUCTION DATA.**

Public production remains frozen at `68603a465f39ff20804f221b5db6e3faf1cdfb11`.

This tranche makes the **existing** Atlas on accepted development baseline
`09b8c2d11312bc8b48b296cfdb85ed5587667814` production-ready. It adds no product
capabilities. ACE-Step stays absent. The current LLM RunPod stays LLM-only.

## What this restores / seals

- Production config refuses Music GPU / ACE-Step env on this host.
- Cutover preflight (`npm run cutover:preflight -- --production`).
- Operator backup (`pg_dump` + CAS copy) and restore-to-new-cluster scripts,
  both gated so they cannot silently overlay production.
- Old-data compatibility: schema is still v9, identical to freeze `68603a4`.
  Waves 1–6 added no SQL. Application rollback to that SHA is schema-compatible.
- Restore drill now includes `dungeon_records` and generated WAV artefacts.
- Native-login production product acceptance for Conversation, Projects/Library,
  Research, OSINT, Writing, Website, and Music (HTTP + browser).
- Authenticated Music Range streams remain fail-closed without a session.

## Architecture freeze (unchanged)

Nexus = WHERE. Execution = HOW. No failover after visible output.
Behaviour ≠ Authority. Server-derived tenant. Server-side Authority.
Thin dungeons. Shared Projects/Files/CAS/context/retrieval/provenance.
Uncertain side effects require reconciliation. RunPod stop/reconciliation intact.

## Out of scope

- Merging this PR.
- Pointing DNS or public traffic at vNext.
- Migrating Atlas Mountain / historical Caspa databases.
- Installing ACE-Step or provisioning a Music GPU.
- Dual-write or zero-downtime HA.

## Operator path

1. `npm run cutover:preflight -- --production` against the intended env.
2. `ATLAS_ALLOW_BACKUP=1 npm run backup` onto a dated directory.
3. Restore rehearsal onto a **new** cluster with `ATLAS_RESTORE_NEW_CLUSTER=1`.
4. Browser + HTTP product acceptance in this CI.
5. Wait for Owner authorization before any traffic switch.

See [VNEXT-CUTOVER-PLAN.md](../VNEXT-CUTOVER-PLAN.md), [RUNBOOKS.md](../RUNBOOKS.md),
and [BACKUP-AND-RECOVERY.md](../BACKUP-AND-RECOVERY.md).
