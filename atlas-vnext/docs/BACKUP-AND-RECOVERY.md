# Backup and recovery

## What is backed up

| Store | Strategy |
|---|---|
| PostgreSQL metadata (projects, jobs, grants, manifests pointers, provenance, outbox) | Periodic logical dump (`pg_dump`) + WAL archiving when hosted. Restore to a new instance, then verify row counts and checksum of `root_manifest_hash` pointers |
| CAS / object store | Versioned bucket replication (or `rclone`/vendor replica). Objects are immutable; restore is copy-back + hash verify |
| Secrets | Not in these stores. Secret manager / sealed config. `secrets.use` is default deny |

## Restore process

1. Restore PostgreSQL from dump/WAL to a **new** cluster (do not overlay a live primary blindly).
2. Restore object store to the matching generation.
3. Integrity: for each project, `root_manifest_hash` must exist in CAS; sample blob SHA-256 matches path layout `sha256/ab/cd/<hex>`.
4. Job rows in `running` at crash are re-queued from checkpoint or marked `failed` when retries are exhausted. `waiting_runtime` stays `waiting_runtime`. Conversation executions that were `queued`/`running` become `failed` / `interrupted`. Never silently continue a dead worker's lease.
5. Declare success only after a read-only canary (list projects, fetch one blob, resume one job).

## Disaster-recovery assumptions

- RPO/RTO are product decisions later; the architecture assumes **metadata and objects can be restored independently** and then reconciled by hash.
- A single-region outage of Postgres without WAL archive is data loss of metadata since last dump. CAS without replica is data loss of blobs.
- Conversation history is not required to restore projects.

## Migration rollback

Schema migrations are forward-only, checksummed, and fail startup visibly. There is no automatic destructive schema recreation. See [PERSISTENCE.md](./PERSISTENCE.md).
