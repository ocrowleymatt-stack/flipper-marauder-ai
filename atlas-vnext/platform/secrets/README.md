# @atlas-vnext/secrets

Secrets never live in conversation, project, or artefact data. They are never logged, and they are never sent to a model unless a controlled adapter requests a named key.

- Tenant-scoped vault (refs + rotation; values stay out of PG rows that UI/search can read).
- Production fails closed if secret infrastructure is missing.
- Same boundary for provider, plugin, and external credentials.
- Reuses the execution `SecretStore` port. No real credentials are committed.

See [docs/TOOLS-AUTH-AUTHORITY.md](../../docs/TOOLS-AUTH-AUTHORITY.md).
