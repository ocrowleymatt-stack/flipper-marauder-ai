# Runbooks

Human-operated. These are not automatic remediations.

## PostgreSQL down or failing checks

1. Confirm `/api/health/live` is 200 and `/api/health/ready` is 503 with `dependencies.postgres=error`.
2. Do not switch the host to memory or the JSON file store.
3. Check `ATLAS_DATABASE_URL` connectivity (`pg_isready`), disk, connections (`pg_stat_activity`), and `statement_timeout`.
4. If the pool is exhausted, restart **one** host after drain; do not raise `ATLAS_DB_POOL_MAX` blindly.
5. Restore from `pg_dump`/WAL onto a **new** instance if the primary is lost. Do not `DROP SCHEMA` to “fix” it.

## CAS missing or divergent

1. `inspectCas` / logs `cas.missing` or `cas.divergence`.
2. Do not serve synthetic file contents.
3. Restore the object from the CAS replica by hash path `sha256/<aa>/<bb>/<hash>`.
4. If metadata points at a hash that never existed, fail the artefact and keep the row for forensics.

## Provider unavailable

- **Before visible output:** Execution may fail over along the Nexus candidate chain. This is expected.
- **After visible output:** Terminal. Do not silently switch. The user starts a new run if they want another provider.
- Mark the provider unhealthy via probes or `ATLAS_KILL_PROVIDERS`. That is a disable-list, not a hardcoded fallback.

## RunPod

Owned by execution, not Workbench/Caspa.

| Symptom | Action |
|---|---|
| API unavailable / auth fail | Provider unhealthy; do not start a second pod |
| Capacity / warm timeout | Job stays `waiting_runtime` or fails visibly; do not bypass the scheduler |
| Stream interrupt | Classify; no second answer after visible tokens |
| Two hosts sharing `runtime.json` | Stop one scheduler; this candidate is single-scheduler |

Do not scale the Node host horizontally in production. Extra processes multiply in-process rate-limit ceilings, do not share live SSE subscribers, and can fight over RunPod `runtime.json`. Production refuses `ATLAS_HA=1` / `ATLAS_REPLICAS>1`.

## Tool uncertain / pending approvals

- `uncertain` means the side effect may have happened. **Do not replay.**
- Pending approvals are durable rows. Refreshing the UI must not create a second approval (idempotency / existing awaiting row).
- Repeated approve of a decided invocation is rejected (`not_awaiting_approval`).
- Restart during `running` + `uncertain_external` → `uncertain`.

## Auth incident

- Revoke the session (`POST /api/session/revoke`) or `revokeAll` for the principal.
- Rotate `ATLAS_SESSION_SECRET` only with coordinated session invalidation (all cookies become unverifiable).
- CSRF/origin failures are 403; do not disable CSRF to unblock a client.

## Cross-tenant incident

1. Treat as a Sev-1. Do not confirm the other tenant’s object ids in any response or ticket copy-paste to the reporter.
2. Check adapter queries include `tenant_id`. UI bugs are not an access grant.
3. Revoke sessions for the actor. Preserve audit logs.

## Failed migration

1. Host will not start. The failed version is **not** recorded.
2. Fix the SQL, deploy, start again. Do not hand-edit `schema_migrations` checksums.
3. Do not run a reverse DROP as recovery.

## Rollback

| Layer | How | Not |
|---|---|---|
| App | Point the process at the previous git SHA / image | “git revert” on a live schema that already migrated |
| Schema | Restore PG from the pre-migration dump | Reverse DROP of additive tables as a casual undo |
| Data | Restore PG dump + CAS generation together | Restore PG without matching CAS (or the reverse) |
| Cutover | Leave DNS/load balancer on the previous system | Switching back after deleting legacy data |

## Feature kill switches

```bash
ATLAS_FLAG_TOOLS=off
ATLAS_FLAG_GENERATION=off
ATLAS_FLAG_DUNGEON_WRITING=off
ATLAS_KILL_PROVIDERS=openai,anthropic
```

These refuse work. They are not Authority.
