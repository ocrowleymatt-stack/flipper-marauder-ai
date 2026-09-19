# First accepted public Atlas vNext baseline

Status: **FROZEN**. This is the first accepted public Atlas vNext application SHA.
It is not a licence to change nginx, DNS, Mountain, ports, or secrets.

| Field | Value |
| --- | --- |
| Accepted merged main | `68603a465f39ff20804f221b5db6e3faf1cdfb11` |
| PR #34 accepted head (pre-squash) | `6662851d562e59bda548e7806ef16929a904caf9` |
| Lineage parent | `ace41a2587db85b2cd090b2c4b18be8414cd79ba` |
| Merge | squash of [PR #34](https://github.com/ocrowleymatt-stack/flipper-marauder-ai/pull/34) |
| Exact-main CI | [35424604752](https://github.com/ocrowleymatt-stack/flipper-marauder-ai/actions/runs/35424604752) `verify` **SUCCESS** |
| Public origin | `https://atlas.ocrowley.com` |
| Production runtime | `127.0.0.1:8790` (loopback; nginx already routes the public origin here) |
| Production build | `production-68603a4-20260919T0552Z` |
| Production profile | `production` / live xAI |
| Staging runtime | `127.0.0.1:8788` |
| Staging build | `staging-68603a4-20260919T0547Z` |
| Frozen | 2026-09-19 |

This document establishes `68603a465f39ff20804f221b5db6e3faf1cdfb11` as the first accepted public Atlas vNext baseline. Later product work (including Caspa Novel Machine) must branch from this SHA and must not restage production unless a later, separately approved release gate says so.

## What this baseline proved

| Gate | Result |
| --- | --- |
| Native production login | Pass. Cookie `atlas_vnext_session` is HttpOnly, Secure, SameSite=Lax. Production bootstrap `POST /api/session` remains disabled. |
| Conversation-first Workbench | Pass. The thread owns the centre. Dungeon/navigation surfaces do not steal it. Back to conversation restores the answer. |
| Visible Nexus output | Pass. `Generating…` then streamed assistant text in the conversation. Live provider `xai` / `grok-4.20-fast`. |
| Completion remains visible | Pass. Authoritative execution `completed`; the answer stays in the thread. |
| Refresh / persistence | Pass. Reload restores the conversation. Follow-up turns persist beside the first. |
| Logout / relogin | Pass. Revoked session is unauthenticated. Relogin issues a fresh session. |
| Tenant identity | Pass. Server-derived from membership. Claimed `x-atlas-tenant` is ignored. |
| Authority | Pass. Unauthenticated doctor/projects 401. Owner doctor allowed. Member doctor hidden. Repair not auto-applied. CSRF and origin enforced. |
| Caspa basic | Pass. Generate / edit / stale-revision 409 / restore as a new version. |
| Files / CAS | Pass. Upload, retrieval, and app-only restart persistence. |
| Application restart | Pass. `docker restart atlas-vnext` (postgres untouched) restored project/file/document and a new live Nexus run. |
| Mountain freeze | Pass. Unit masked/inactive. `43101` / `43105` unbound. |
| Isolation | Pass. Production and staging have distinct names, volumes, DBs, CAS, cookies, and loopback ports. PostgreSQL unpublished. |

Private-production Nexus proof (API): `exe_8fbc7dc0-a9ed-4b72-a35f-fa8a2e9abd28` `xai/grok-4.20-fast` `completed`.

Public Workbench Nexus proof: `exe_e608036c-d0d6-4610-8128-0f02d949fbb2` `xai/grok-4.20-fast`. Visible marker remained in the centre with OSINT selected in the rail.

Post-freeze bounded smoke (2026-09-19, production unchanged): native login, owner doctor `ATTENTION_REQUIRED`, Files/CAS list 200, live Nexus `exe_a3cfc13d-8cb3-4c99-9abb-39fe08f8aa63` with `assistant.delta`, conversation GET persistence. Doctor Attention remains the expected optional-Ollama residual.


## Isolation freeze

- nginx MainPID at acceptance: `3180766`
- `auth-gateway.conf` sha256: `f9dc80b38aa605a7cb80768edb9ccc2ce6a40e59fc9cffc141bedafd24bebc30`
- Mountain: masked / inactive
- Production cookie: `atlas_vnext_session`
- Staging cookie: `atlas_vnext_staging_session`
- Allowed origin: `https://atlas.ocrowley.com`
- Do not change nginx, DNS, TLS, Mountain, or published ports as part of product work on this baseline

## Rollback (application only)

Do **not** run the nginx cutover rollback unless the public origin itself must leave vNext. Application rollback restages this SHA's predecessor onto `127.0.0.1:8790` with the **current** nginx hashes:

- source backup: `/root/atlas-vnext-prod-src-ace41a2-20260919T0552Z`
- tarball: `/root/atlas-vnext-ace41a2.tar.gz`
- prior image: `atlas-vnext:ace41a2587db85b2cd090b2c4b18be8414cd79ba`
- accepted image: `atlas-vnext:68603a465f39ff20804f221b5db6e3faf1cdfb11`

## Bounded residual (do not reopen the release)

Run-details completion presentation can remain stale (`Generating…` chip / missing completed timestamp) after the authoritative execution and conversation are completed. Authoritative execution state is the source of truth. Tracked as a post-release UI/inspection defect; not a visible-output regression and not a Nexus/Execution ownership change.

Doctor **Attention** is expected while optional Ollama is absent.

## Protected contracts (unchanged)

- Nexus owns WHERE.
- Execution owns HOW.
- No provider failover after visible output.
- Behaviour is not Authority.
- Tenant identity is server-derived.
- Authority is server-side.
- Uncertain external side effects require reconciliation.
- Provider implementation details do not leak into Caspa/Dungeon contracts.
- Dungeons remain thin consumers of Projects, Files/CAS, context, Nexus, Execution, tools, auth, tenancy, and Authority.
