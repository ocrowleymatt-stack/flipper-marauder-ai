# @atlas-vnext/plugins

Plugin identity, version, tools, config/secret names, Authority requirements, health, and rate limits.

Plugins execute through the same tool engine and Authority gate. They cannot bypass policy or self-grant capabilities. Unknown or disabled plugins fail closed.

This tranche ships one in-process mock connector (`plugin.mock.echo`) that proves the E2E path without paid credentials.

See [docs/TOOLS-AUTH-AUTHORITY.md](../../docs/TOOLS-AUTH-AUTHORITY.md).
