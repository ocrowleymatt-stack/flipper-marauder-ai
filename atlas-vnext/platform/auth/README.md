# @atlas-vnext/auth

Production-shaped authentication, not a vendor SDK.

- **Principal**: user, optional guest, system.
- **Membership**: tenant and workspace membership are the source of truth. A caller-supplied tenant id is a claim, not authorisation.
- **Session**: opaque id, expiry, rotation, revocation. Stale/revoked sessions fail closed.
- **CSRF**: required for mutating browser requests that use the session cookie.
- **Origin**: validated when an allow-list is configured.
- **Cookies**: `HttpOnly; SameSite=Lax; Path=/;` plus `Secure` in production.
- **Native login**: `POST /api/auth/login` verifies a scrypt password hash, then calls existing `AuthService.issueSession`. Tenant is derived from membership. Production does **not** re-enable `POST /api/session`. First owner credentials are provisioned with `npm run auth:provision` (password on stdin). Argon2id is preferred; scrypt via `node:crypto` (`N=16384,r=8,p=1`) is used because the production Node 20 slim image has no C toolchain for a native argon2 add-on.


The host injects this service. Dungeons and UI must not implement a second login path.

See [docs/TOOLS-AUTH-AUTHORITY.md](../../docs/TOOLS-AUTH-AUTHORITY.md).
