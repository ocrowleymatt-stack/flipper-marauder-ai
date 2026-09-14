# @atlas-vnext/permissions

Platform Authority gate. Default deny. Resource-scoped. IDs, hashes, CAS pointers, job ids, and tool ids are **not** authorisation.

- Behaviour (Open/Standard) never widens Authority. Invalid Behaviour fails closed.
- Plugins cannot bypass this gate or self-grant capabilities.
- Cross-tenant access fails closed with a generic denial (no existence leak).
- No giant `isAdmin`. `admin.configure` is one capability among many.

See [docs/TOOLS-AUTH-AUTHORITY.md](../../docs/TOOLS-AUTH-AUTHORITY.md).
