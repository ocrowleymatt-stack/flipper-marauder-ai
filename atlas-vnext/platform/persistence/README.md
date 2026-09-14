# Persistence

Durable metadata adapter for local/dev. The document schema matches the PostgreSQL target:

- conversations
- messages
- executions
- events (transactional outbox-shaped log)
- provenance

Production will swap this file document for PostgreSQL + CAS without changing conversation ports. Message text of conversational scale stays in metadata; blobs remain CAS.
