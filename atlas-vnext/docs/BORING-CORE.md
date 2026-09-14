# Boring core

Atlas vNext is a **modular monolith**.

| Concern | Choice | Why |
|---|---|---|
| Process topology | One deployable (later split only if proven) | Avoid distributed debugging before there is a product |
| Transactional metadata | **PostgreSQL** | Caspa already proved PG for immutable manuscript versions and conflict checks. Jobs, grants, outbox, and project rows need ACID, constraints, and boring backups. SQLite is acceptable only as a local/dev stand-in with the **same schema**, not a second product database |
| Large/immutable content | **CAS / object storage** (SHA-256) | Never put file bytes or base64 in relational rows |
| Jobs | One `platform/jobs` | No per-dungeon runners |
| Events | One `platform/events` (SSE first) | No polling loops for active views |
| Permissions | One `platform/permissions` | Default deny; no scattered checks |
| Provider execution | One `platform/execution` | Nexus does not open sockets |

## Explicitly not in the design gate

Do **not** introduce Kafka, Kubernetes, Temporal, a service mesh, microservices-as-the-architecture, or extra databases (Mongo, Elasticsearch-as-source-of-truth, Redis-as-job-store) unless a later subsystem review proves a specific failure of this core.

Redis, if used later, is a cache/lock — not a system of record.
