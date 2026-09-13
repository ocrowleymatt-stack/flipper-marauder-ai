# Restore runbook

This procedure exists **before** Atlas vNext stores production data. If a step cannot be executed yet, it is still the contract a later implementation must satisfy.

## What is backed up

| Dataset | Location (target) | Consistency |
|---|---|---|
| Tenant CAS blobs | `runtimes/hetzner` data volume `/var/lib/atlas/cas/` | Files are immutable; copy is crash-safe |
| Manifests / object refs / projects / jobs / events | SQLite (or successor) under `/var/lib/atlas/tenants/<tenantId>/` | Snapshot with SQLite backup API or volume freeze |
| Secrets / vault | encrypted blob, not in CAS plaintext | Restore separately; never into logs |
| Release pointer | `/opt/atlas/current` → immutable release id | Not tenant data |

Owner and guest tenants are **separate directories**. Never merge them on restore.

## Backup (once the store exists)

1. For each tenant DB: `sqlite3 "$db" ".backup '$scratch/$tenant.sqlite'"` then `sha256sum`.
2. rsync CAS with `--ignore-existing` (blobs never change).
3. Write a **manifest** `{ takenAt, releaseSha, tenantHashes[], casPrefix }`.
4. Copy manifest + DBs + cas delta off-box. A backup without the manifest is incomplete.

Until those paths exist, CI must still be able to run `ops/backup/check-restore-contract.sh` (structure check).

## Restore to a new host

1. Provision host; install the **same** `releaseSha` as the backup manifest (or a newer release that has migrations for that schemaVersion).
2. Do **not** start Nexus/apps yet.
3. Restore tenant directories one at a time. Verify each `sha256` against the backup manifest.
4. `cas verify --sample 1%` (implementation later): every sampled blob's bytes hash to its digest. Mismatch → abort, do not serve.
5. Run schema migrations if the release is newer. Never restore a newer DB onto an older binary.
6. Start the platform in **read-only** mode if available; otherwise start normally and immediately run health:
   - process up
   - can read one project object
   - can resolve `nexus/fast` against the restored registry
7. If health fails: stop, keep the previous host in service, discard this restore. A successful file copy is not a successful restore.
8. Only then update the load-balancer / DNS pointer.

## Guest isolation

Restoring the owner tenant must not copy guest DBs into the owner tree. Guest restore is opt-in per tenant id.

## Failure modes

| Symptom | Action |
|---|---|
| Digest mismatch | Fail restore; restore from older backup |
| Missing backup manifest | Do not guess; treat as corrupt |
| Partial CAS | Serve only if missing blobs are not referenced by live refs; otherwise fail |
| Secrets missing | Platform may boot; jobs needing `secrets.use` stay blocked |

## Drill

Run this runbook on empty fixtures in staging whenever `ops/deploy` changes. Record the last successful drill date in the backup manifest store (not in git).
