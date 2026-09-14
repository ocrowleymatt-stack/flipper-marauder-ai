# Persistence

Durable metadata adapter for local/dev. The document schema matches the PostgreSQL target:

- conversations
- messages
- executions
- events (transactional outbox-shaped log)
- provenance

Production will swap this file document for PostgreSQL + CAS without changing conversation ports. Message text of conversational scale stays in metadata; blobs remain CAS.

**This file store is not final.** Next durability work must move conversations, messages, executions, events/outbox, and provenance into PostgreSQL. Execution must remain decoupled from the storage adapter (it already is: conversation ports only).
