# Transactional deployment

A CI green build is **not** production health. Promote is a transaction with rollback.

## Release artefact

A release is immutable:

```text
atlas-vnext-<gitsha>
  tree of built workspaces
  contracts schemaVersion
  ATLAS_RELEASE_SHA=<gitsha>
```

Never mutate a released directory. New commits are new releases.

## Promote transaction

```text
1. Upload artefact to /opt/atlas/releases/<sha>  (write-only, not live)
2. Run release-local checks (migrations dry-run, nexus contract tests if present)
3. Flip pointer /opt/atlas/current → <sha>       (atomic symlink replace)
4. Restart platform processes
5. VERIFY (blocking):
     - GET /health (when HTTP exists) includes releaseSha == <sha>
     - nexus/fast resolves against live registry
     - can read a canary project
     - no crash loop for N seconds
6. On verify failure: pointer → previous sha, restart, re-verify previous
7. Only after verify: mark release "live" in the deployment record
```

If step 5 fails, production stays on the previous pointer. Do not "fix forward" by editing the live tree.

## Serialized production

One promote at a time (Atlas Mountain lesson: workflow concurrency group). A second promote waits.

## Verify ≠ build

| Build (CI) | Verify (production) |
|---|---|
| unit/contract tests | process actually bound and serving |
| typecheck | canary project readable |
| artefact exists | releaseSha matches pointer |
| migrations apply on empty DB | migrations applied on real tenant DBs |

Website Studio "production" status (Mountain) meant "do not auto-expire". Here **production** means verified live.

## Rollback

Rollback is the same transaction with an older sha. It is not a git revert on the host. Data migrations must be backward-compatible or rollback is blocked (job records with newer schemaVersion stay unread until a forward fix).

## This phase

No host installer yet. `ops/deploy/check-deploy-contract.sh` asserts this document still contains the transaction steps.
