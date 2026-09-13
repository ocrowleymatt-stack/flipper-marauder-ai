# ops/backup

**Status:** placeholder. Not an npm package.

## Intent

Backup and restore of durable Atlas state under `ATLAS_DATA_DIR`: content-addressed blobs,
manifests, project metadata, job records and the event log. Because blobs are content-addressed,
backups are incremental by construction and restores are verifiable by digest.

## Will contain

- backup and restore scripts with digest verification
- retention policy and schedule
- restore drills documented as runbooks

## Must NOT contain

- application code or anything imported by workspace packages
- credentials for backup targets
