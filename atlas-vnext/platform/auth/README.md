# @atlas-vnext/auth

Production-shaped authentication, not a vendor SDK.

- **Principal**: user, optional guest, system.
- **Membership**: tenant and workspace membership are the source of truth. A caller-supplied tenant id is a claim, not authorisation.
- **Session**: opaque id, expiry, rotation, revocation. Stale/revoked sessions fail closed.
- **CSRF**: required for mutating browser requests that use the session cookie.
- **Origin**: validated when an allow-list is configured.
- **Cookies**: `HttpOnly; SameSite=Lax; Path=/;` plus `Secure` in production.

The host injects this service. Dungeons and UI must not implement a second login path.

See [docs/TOOLS-AUTH-AUTHORITY.md](../../docs/TOOLS-AUTH-AUTHORITY.md).
