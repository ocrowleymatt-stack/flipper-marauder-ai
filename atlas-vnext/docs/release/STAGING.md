# Private Staging v1

Isolated Atlas vNext alongside original Atlas. **Not a cutover.**

## Isolation

| Concern | Original Atlas | vNext staging |
|---|---|---|
| Public URL | `https://atlas.ocrowley.com` :80/:443 | none by default |
| Process | `/opt/atlas-mountain`, Nexus `:43101`, native-auth `:43105` | containers `atlas-vnext-staging`, `atlas-vnext-staging-pg` |
| Host port | 80/443/43101/43105 | `127.0.0.1:8788` → container `8787` |
| Database | original Atlas DB (untouched) | volume `atlas-vnext-staging-pgdata`, db `atlas_vnext_staging` |
| CAS | original writable store (untouched) | volume `atlas-vnext-staging-cas` |
| Cookie | `atlas_session` | `atlas_vnext_staging_session` |
| Tenant | production tenant | `tenant_staging_owner` |
| Env file | `/etc/atlas` (untouched) | `/etc/atlas-vnext-staging/staging.env` |
| Network | existing | docker network `atlas-vnext-staging` |

Protected paths the install script will not write: `/opt/atlas-mountain`, `/opt/atlas`, `/var/lib/atlas`, `/etc/atlas`, nginx atlas snippets.

## Why `ATLAS_ENV=staging`

Production `NODE_ENV`/`ATLAS_ENV=production` **disables** `POST /api/session` bootstrap. Staging must keep `ATLAS_ENV=staging` and `NODE_ENV=staging` so the owner can authenticate. Dockerfile `ENV NODE_ENV=production` is overridden by compose.

Do not copy original Atlas secrets into staging.

## Install (Hetzner, as root)

From a checkout of this tree on the host, **after** filling `/etc/atlas-vnext-staging/staging.env`:

```bash
# copy atlas-vnext/ops/staging/env.staging.example → /etc/atlas-vnext-staging/staging.env
# set ATLAS_SOURCE_SHA to the exact git SHA you built
# set ATLAS_STAGING_PG_PASSWORD and ATLAS_SESSION_SECRET (new random values)
# set ATLAS_ALLOWED_ORIGINS to the origin the browser will use
atlas-vnext/ops/staging/install-alongside.sh
```

The script refuses to run if `:8788` is already bound. It does not restart nginx, Nexus, or original Atlas units.

Confirm original Atlas still answers `https://atlas.ocrowley.com/auth/status` after install.

## Owner access

Default bind is loopback. That is safe and **not** browser-reachable from your laptop.

To reach staging without touching original nginx:

1. Prefer an SSH tunnel: `ssh -L 8788:127.0.0.1:8788 root@116.202.24.63` then open `http://127.0.0.1:8788` with `ATLAS_ALLOWED_ORIGINS=http://127.0.0.1:8788`.
2. Only if a tunnel is impossible: set `ATLAS_STAGING_BIND=0.0.0.0`, firewall-allow **only** the owner IP on tcp/8788, set `ATLAS_ALLOWED_ORIGINS` to `http://<host-ip>:8788`. Do not open Postgres. Do not change :80/:443.

Do not weaken cookies, CORS, or auth to force a bare IP. If the browser refuses the origin, stop and add a **new** hostname/reverse-proxy location that does not replace `atlas.ocrowley.com`.

On first load the Workbench calls `POST /api/session` (allowed only because this is not production) and becomes the host owner.

## Identity

`GET /api/health` includes `{ identity: { sourceSha, buildId, profile } }`. Help & Repair shows the SHA.

## Resource limits

Compose caps: host 1 CPU / 1 GiB, Postgres 0.5 CPU / 512 MiB. Re-measure host CPU/RAM/disk **on the machine** before `up`. This sandbox cannot SSH to Hetzner.

## Acceptance fixture

Owner checklist (do not mark accepted until these pass on the running staging instance):

1. Reach staging URL.
2. Authenticate (bootstrap).
3. Open Workbench.
4. Create a project.
5. Upload a real file.
6. See it persist.
7. Reload; project/file return.
8. Ask a question that needs that file.
9. Get a sourced answer.
10. Use a normal conversation.
11. Use Caspa/Writing.
12. Open Investigation.
13–19. Chronology, thread, claim/evidence, corroboration, contradiction, unsupported hypothesis.
20. Targeted retrieval (compiled context, not whole estate).
21–22. Slow Cook yields to interactive work.
23–25. Help & Repair: doctor report; harmless check; consequential `repair.migrate_schema` stays proposed/denied.
26–27. Denied and approval-required operations.
28. Tenant/project isolation (owner staging is single-tenant; do not copy production data).
29. Provenance survives reload.
30. `https://atlas.ocrowley.com/auth/status` still works; original processes untouched.

## Failure policy

If staging fails, classify CONFIG / MIGRATION / PERSISTENCE / NETWORK / AUTH / PROVIDER / WORKER / CAS / RETRIEVAL / UI / AUTHORITY / RESOURCE and fix only that. Do not modify original Atlas.
