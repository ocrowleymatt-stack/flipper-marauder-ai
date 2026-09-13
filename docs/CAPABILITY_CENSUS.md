# Atlas vNext: Repository Capability Census & Reference Audit

## 1. Executive Summary

This audit assesses the behavioural, architectural, and operational patterns across the reference repositories (`atlas-mountain`, `ocrowley-commons`, `Caspa`, `hanflow`, `spiral-mind`) to inform the greenfield clean-room reconstruction of **Atlas vNext** in `flipper-marauder-ai`.

As mandated:
- `flipper-marauder-ai` is the **only writable target repository**.
- `atlas-mountain` and other repositories are **strictly behavioural reference sources** and must not be bulk-copied or treated as architectural templates.
- Atlas vNext replaces monolithic designs with a clean-room modular architecture featuring:
  - Deliberately thin **Nexus Router** (stateless routing, circuit breaking, fallback cascades).
  - Standalone **Execution Broker** (sandboxed execution, lease management, worker decoupling).
  - **Durable Projects and Jobs** (transactional persistence, idempotent state transitions).
  - **Content-Addressed Storage (CAS)** (immutable content deduplication, integrity validation).
  - **Event-Driven Progress** (real-time pub/sub, SSE, event ledgers).
  - **Explicit Provenance** (cryptographic hash chains, tamper-evident audit trails).
  - **Capability-Based Permissions** (fine-grained, context-aware policy enforcement).
  - **Isolated Domain Modules & Plugin-Style Dungeons** (modular extension points).

---

## 2. Audited Reference Repositories

### 2.1 `atlas-mountain` (Java 21 / Spring Boot 4)
* **Role**: Backend foundation reference for authentication, database synchronization, locking, and rate limiting.
* **Core Capabilities**:
  - **Dual Auth**: Sa-Token session management alongside prefix/hash API Tokens (`ak_<prefix>_<secret>` format, SHA-256 hashed).
  - **Distributed Locks**: Redisson-backed distributed locking with SpEL expression key resolution and fallback timeouts.
  - **Rate Limiting**: In-memory Bucket4j token bucket rate limiting on sensitive routes (e.g. `/api/auth/login`).
  - **Change Data Capture (CDC)**: MySQL binlog replication engine (`mysql-binlog-connector-java`) parsing `TABLE_MAP`, `WRITE_ROWS`, `UPDATE_ROWS`, and `DELETE_ROWS` events to trigger independent handlers.
  - **Layer Enforcement**: ArchUnit rules strictly isolating Controllers from DAOs/Mappers and restricting Mapper access to DAO implementations.
* **Architectural Critique**:
  - Monolithic single-application Java/Spring Boot design with tightly coupled persistence patterns.
  - Binlog CDC is hard-bound to MySQL replication protocols; not easily adapted to modern multi-cloud or lightweight storage engines.
* **Port / Redesign / Discard Verdict**:
  - **Port (Behavioural & Conceptual)**: Prefix/hash API token verification pattern (`ak_<prefix>_<secret>`); Token Bucket rate limiting contract; Distributed lock semantics (leases, wait times).
  - **Redesign**: Reimplement dual authentication and rate limiting in TypeScript native middleware; replace binlog CDC with an internal transactional Outbox/Event-bus architecture for event-driven durability.
  - **Discard**: Heavyweight Spring Boot / MyBatis-Plus scaffolding, Java reflection-based SpEL key resolvers, and rigid monolithic packaging.

---

### 2.2 `ocrowley-commons` (TypeScript Monorepo & Python Cores)
* **Role**: Shared library foundation extracted from historical stack implementations.
* **Key Packages & Capabilities**:
  - `@ocrowley/policy`: Pure deterministic allow/deny policy engine with rule prioritization, context attributes, and default-deny posture.
  - `@ocrowley/audit`: Hash-chained tamper-evident append-only ledger (`AuditLedger`) using SHA-256 and constant-time equality checks (`timingSafeEqual`).
  - `@ocrowley/jobs` & `@ocrowley/persistence`: File-backed atomic job queue (`writeJsonFile` via `.tmp` rename) with stages, worker leases, and `SSEBroadcaster`.
  - `@ocrowley/intent`: Output contract router separating action (`WRITE_BOOK`, `POLISH`, `CUT`) from requested output (`PLAN`, `NOVEL_PROSE`) to prevent unintentional plan generation.
  - `@ocrowley/quality`: Deterministic quality gates, AI-fog/stock-phrase detection (`AI_FOG_PATTERNS`), and citation integrity verification.
  - `@ocrowley/coherence`: Comprehensive literary craft, psychological impact, and narrative tension libraries (e.g., Zeigarnik effect, Curiosity Gap, Iceberg dialogue).
  - `@ocrowley/osint` & `@ocrowley/darkweb`: Recursive reconnaissance engines, probe normalization, dossier models, and privacy-governed breach query contracts.
* **Architectural Critique**:
  - Contains valuable pure contracts and algorithms, but persistence relies primarily on local filesystem JSON files rather than robust content-addressed storage or transactional databases.
* **Port / Redesign / Discard Verdict**:
  - **Port (Algorithms & Contracts)**: Pure policy engine (`PolicyEngine`), audit hash-chaining logic (`AuditLedger`), AI-smell / quality gate heuristics, and output contracts.
  - **Redesign**: Upgrade `@ocrowley/jobs` and `@ocrowley/persistence` to use PostgreSQL transactional storage alongside Content-Addressed Storage (CAS) for artifact payloads.
  - **Discard**: Ad-hoc filesystem JSON storage as primary database; direct CLI shell-out hooks.

---

### 2.3 `Caspa` (Node.js / Express / React)
* **Role**: Production creative platform with AI routing, project revision control, and cloud knowledge synchronization.
* **Discovered Capabilities**:
  - **Autonomous Cloud Knowledge Ingestion (`cloudKnowledgeAutopilotService`)**:
    - Unattended background sync for Dropbox and Google Drive.
    - Token storage protected with AES-256-GCM encryption at rest (`CLOUD_TOKEN_ENCRYPTION_KEY`).
    - Ephemeral streaming to temporary disks: retains parsed text, chunks, and embeddings; original audio/video/document stays in user cloud.
    - Media transcription and document parsing pipelines with deduplication.
  - **PostgreSQL Project & Version Storage (`projectRepository`, `hybridCoreRepository`)**:
    - Project revision trees, checksum tracking (`projectChecksum` via SHA-256 over normalized JSON).
    - Optimistic concurrency control (`assertExpectedSourceVersion`, `HybridConflictError`).
    - Immutable manuscript versions with word and chapter telemetry.
  - **Resilient AI Routing & Recovery Fabric (`cloudModelRouter`, `routerFailover`, `nexusRecovery`)**:
    - Multi-provider fallback cascade: Local/Host Unified Router (`UNIFIED_ROUTER_URL`) -> Cloud providers (Grok, Gemini, OpenAI, Claude, Venice).
    - Provider circuit breaking (`aiBreaker`), quota/billing cooldown segregation (`BILLING_COOLDOWN_MS`), and dynamic task classification (`classifyTask`).
    - Automated incident capture and retry governance (`reportNexusIncident`, `callWithNexusRecovery`).
  - **Production Security & Identity Gateway (`authenticatedUser`)**:
    - Reverse-proxy verification via shared high-entropy secret (`CASPA_PROXY_SHARED_SECRET`) and trusted identity headers (`X-Authentik-UID`, `X-Authentik-Groups`).
    - Role-based operator gating (`CASPA_OPS_GROUPS`).
* **Architectural Critique**:
  - Monolithic `server.ts` (>1,800 lines) coupling HTTP routing, AI provider calls, database queries, and filesystem utilities in one process.
* **Port / Redesign / Discard Verdict**:
  - **Port (Key Mechanisms)**: Multi-provider fallback and quota-aware circuit breaking; optimistic concurrency versioning; proxy-secret identity verification.
  - **Redesign**: Extract the routing cascade into the dedicated **Nexus Router** module; extract execution and knowledge ingestion into the **Execution Broker** and domain modules; decouple database repositories into modular data access layers.
  - **Discard**: Monolithic single-file server structure, synchronous heavy processing in HTTP request loops, and untyped ad-hoc Express route handlers.

---

### 2.4 External Reference Discoveries: `hanflow` & `spiral-mind`
* **Discoveries Outside `atlas-mountain`**:
  - `hanflow`:
    - Unified DSL for static DAG workflows and dynamic multi-agent loops compiled to LangGraph `StateGraph`.
    - **Hard-constraint privacy model routing** (`PrivacyStrategy` vetoing remote execution on PII/sensitive data).
    - Extensible MCP tool bus supporting 5 transports (`stdio`, `sse`, `http`, `websocket`, `inprocess`).
    - Multi-backend RAG retrieval (vector, full-text, hybrid with RRF/cascade fusion).
    - Sandboxed execution isolating code runs across multiple safety tiers.
  - `spiral-mind`:
    - Clean TypeScript-native agent harness model:
      $$\text{User} \to \text{messages}[] \to \text{model} \to \text{stop\_reason} \to \text{tool\_use} \to \text{TOOL\_HANDLERS} \to \text{tool\_result} \to \text{loop}$$
    - Explicit permission gates before handler execution (`PermissionPolicy` checking `tool_use`).
    - Read-only observable hooks (`beforeToolUse`, `afterToolUse`, `onModelResponse`) for auditability.
* **Value to Atlas vNext**:
  - `spiral-mind` provides the exact clean-room agent loop and capability-permission interception model needed for the Execution Broker.
  - `hanflow` provides proven patterns for plugin-style Dungeons (modular node primitives), privacy routing vetoes, and tool buses.

---

## 3. High-Level Capability Matrix

| Capability Area | `atlas-mountain` Reference | Stack / `Caspa` / `commons` Reference | Atlas vNext Target Architecture |
|---|---|---|---|
| **API Routing & Proxy** | Spring Boot MVC Controllers | Express monolithic routing (`server.ts`) | **Nexus Router**: Ultra-thin, stateless request router with circuit breaking & failover |
| **Execution & Workflows** | Spring `@Async` / embedded threadpools | Ad-hoc async functions & timeout loops | **Execution Broker**: Isolated task runner, lease tracking, worker isolation |
| **Data Storage & State** | MySQL + MyBatis-Plus + Flyway | PostgreSQL JSONB + local filesystem JSON | **Durable Projects & Jobs**: Transactional PostgreSQL state + immutable versioning |
| **Artifact Persistence** | None (DB records only) | Local filesystem `data/` directory | **Content-Addressed Storage (CAS)**: SHA-256 chunked immutable object store |
| **Audit & Provenance** | Basic audit fields (`created_by`, `updated_at`) | SHA-256 hash-chained `AuditLedger` | **Cryptographic Provenance**: Merkle/hash-chained audit entries & artifact checksums |
| **Security & Access** | Sa-Token sessions + prefix/hash tokens | Authentik proxy headers + shared secret | **Capability-Based Permissions**: Granular capability tokens, context policy engine |
| **Event Progress** | MySQL binlog CDC listener | Polling + basic `SSEBroadcaster` | **Event-Driven Progress**: Pub/Sub bus, typed event streaming, reconnectable SSE |
| **Domain Extensibility** | Monolithic layered packages | Independent npm packages in commons | **Plugin-Style Dungeons**: Isolated domain modules registering capabilities & hooks |
