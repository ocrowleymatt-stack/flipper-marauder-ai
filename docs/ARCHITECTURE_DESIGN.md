# Atlas vNext: Architectural Blueprint & System Design

## 1. System Vision & Clean-Room Principles

Atlas vNext is a distributed, event-driven intelligent operating platform designed from the ground up for high reliability, verifiable provenance, strict security boundaries, and modular domain extensibility.

### Core Architectural Axioms
1. **Separation of Routing and Execution**: The Nexus Router never executes untrusted or heavy workloads. It only verifies identity/capabilities, routes requests, manages provider fallbacks, and delegates execution to the Execution Broker.
2. **Immutability by Default**: All artifacts and project revisions are content-addressed and verified via cryptographic checksums (SHA-256). State is never mutated in-place; state advances via versioned append-only transitions.
3. **Capability-Based Access Control**: No global superusers or blanket permissions. Access to resources, models, and tools requires explicitly declared and cryptographically verified capabilities.
4. **Verifiable Provenance**: Every output, revision, and mutation links back to its input sources, tool invocations, operator identities, and execution environment via hash-chained audit ledgers.
5. **Decoupled Plugin Dungeons**: Specialized capabilities (creative writing, OSINT reconnaissance, knowledge autopilot, quality evaluation) run as isolated plugin "Dungeons" conforming to standard extension contracts.

```
                    +------------------------------------------+
                    |             Client Requests              |
                    +--------------------+---------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------+
|                                NEXUS ROUTER                                       |
|  - Auth & Capability Verification  - Model Provider Cascade & Circuit Breaker     |
|  - Rate Limiting (Token Bucket)    - Dynamic Routing & Recovery Logging           |
+--------------------+------------------------------------+-------------------------+
                     |                                    |
                     v (sync query/model route)           v (async job dispatch)
          +----------------------+             +------------------------------------+
          | Unified AI Providers |             |          EXECUTION BROKER          |
          |  - Ollama / Host     |             |  - Job Queue & Lease Management    |
          |  - Grok / Gemini     |             |  - Sandboxed Runner Isolation      |
          |  - Claude / OpenAI   |             |  - Event Stream Broadcaster (SSE)  |
          +----------------------+             +------------------+-----------------+
                                                                  |
                      +-------------------------------------------+
                      |                      |                    |
                      v                      v                    v
          +-----------------------+ +------------------+ +-------------------------+
          |      DUNGEON:         | |     DUNGEON:     | |        DUNGEON:         |
          |   Creative Studio     | |     OSINT WHO    | |   Knowledge Autopilot   |
          | (Psych/Craft/Quality) | | (Probe/Recon)    | | (Dropbox/GDrive/Extract)|
          +-----------+-----------+ +--------+---------+ +------------+------------+
                      |                      |                        |
                      +----------------------+------------------------+
                                             |
                                             v
+-----------------------------------------------------------------------------------+
|                           STORAGE & PERSISTENCE FABRIC                            |
|  - PostgreSQL: Durable Projects, Jobs, State Transitions, & Event Log             |
|  - Content-Addressed Storage (CAS): Immutable Blobs & Artifacts (SHA-256)         |
|  - Tamper-Evident Audit Ledger: SHA-256 Merkle / Hash-Chained Entries             |
+-----------------------------------------------------------------------------------+
```

---

## 2. Core Subsystems

### 2.1 Nexus Router
The Nexus Router is deliberately lean, stateless, and focused on request intake and traffic orchestration:
- **Authentication Gateway**: Dual-verification supporting:
  - Reverse proxy shared secret validation (`X-Atlas-Proxy-Secret` via constant-time comparison).
  - Authenticated user identity injection (`X-Authentik-UID`, email, groups).
  - High-entropy API Token authentication (`ak_<prefix>_<secret>` verified against stored SHA-256 hashes).
- **Rate Limiting Engine**: Native Token Bucket algorithm enforcing strict request thresholds per user/token to protect system resources.
- **Model Router & Fallback Cascade**:
  - Primary path: Host Unified Router (`UNIFIED_ROUTER_URL`) -> Cloud providers (Grok, Gemini, Claude, OpenAI, Venice) -> Local fallback.
  - Quota/Billing Cooldown: Provider-specific cooldown timers (`BILLING_COOLDOWN_MS`) ensure billing exhaustion on one provider automatically routes traffic to healthy alternates.
  - Circuit Breakers: Fast-fail mechanisms preventing cascading latencies across external endpoints.

### 2.2 Execution Broker
The Execution Broker decouples asynchronous task processing from HTTP request-response cycles:
- **Durable Job Management**:
  - Jobs are created with unique IDs, user scopes, optional project affiliations, and idempotency keys.
  - Distinct state transitions: `queued` $\to$ `running` $\to$ `completed` | `failed` | `cancelled` | `needs_review`.
- **Worker Lease Management**:
  - Distributed worker leases with heartbeat expirations (`lease_until`, `lease_owner`).
  - Stale worker detection and automatic reclamation of abandoned tasks.
- **Event-Driven Progress**:
  - Granular progress reporting per job stage.
  - Outbox event streaming to `SSEBroadcaster` channels allowing clients to observe real-time job execution without polling.

### 2.3 Durable Projects & Storage Fabric
- **Transactional State Management**:
  - Relational tables in PostgreSQL managing project metadata, users, revisions, jobs, and events.
  - Strict optimistic locking enforcing source version verification (`expectedSourceVersionId`) to eliminate silent write overwrite bugs.
- **Content-Addressed Storage (CAS)**:
  - Artifacts, manuscripts, dossiers, and external source snapshots are stored as immutable blobs identified strictly by their SHA-256 content hash.
  - Automatic deduplication: identical payloads reference the same storage block.
  - Verifiable integrity: read operations validate hash matches prior to returning data.

### 2.4 Cryptographic Provenance & Audit
- **Tamper-Evident Audit Ledger**:
  - Append-only ledger recording all security events, state modifications, tool invocations, and deployments.
  - Hash-chaining: Each entry $E_i$ embeds the SHA-256 hash of $E_{i-1}$, forming a cryptographically verifiable chain starting from `GENESIS`.
  - Constant-time verification routines validate ledger integrity at any point in time.
- **Explicit Artifact Provenance**:
  - Every job execution produces a `JobProvenance` descriptor detailing input checksums, model fingerprints, tool invocation trails, and human-in-the-loop decisions.

### 2.5 Capability-Based Permissions
- **Default-Deny Policy Architecture**:
  - Actions require explicitly matched positive capability grants.
  - Rules evaluate actor identity, verified roles, required capabilities, resource classifications (`public`, `internal`, `confidential`, `restricted`), and runtime environment (`development`, `staging`, `production`).
  - Strict deny-override priority: Any explicit deny rule instantly vetoes execution regardless of matching allow rules.

### 2.6 Plugin-Style Dungeons
Dungeons represent domain-specific capability bundles that register with the Execution Broker and Nexus Router via uniform contracts:
- **`DungeonManifest`**:
  - Unique dungeon identifier, semantic version, and description.
  - Declared capabilities provided (e.g. `creative:draft`, `osint:who_lookup`, `knowledge:sync`).
  - Declared required permissions and environmental prerequisites.
- **Standard Lifecycle**:
  - `initialize(context)`: Configure persistence hooks, schema migrations, and external clients.
  - `execute(task)`: Handle dispatched job steps within isolated execution contexts.
  - `health()`: Report operational readiness and provider connectivity.

---

## 3. Technology Stack & Monorepo Architecture

Atlas vNext is structured as a modern TypeScript/Node.js monorepo using standard package management and strict type-safety:
- **Monorepo Structure**:
  - `packages/core-contracts`: Shared interfaces, types, and schemas for router, broker, CAS, jobs, and policies.
  - `packages/nexus-router`: Stateless API routing, authentication, rate-limiting, and AI provider fallback.
  - `packages/execution-broker`: Job queuing, lease coordination, stage progress, and SSE streaming.
  - `packages/storage-cas`: Content-addressed storage engine and PostgreSQL repository adapters.
  - `packages/policy-provenance`: Capability-based policy engine and hash-chained audit ledger.
  - `packages/dungeon-creative`: Creative writing, psychological craft, and quality gate domain plugin.
  - `packages/dungeon-osint`: Recursive reconnaissance, entity normalization, and dossier domain plugin.
  - `packages/dungeon-knowledge`: Cloud knowledge ingestion, token vault, and document parsing domain plugin.
- **Verification & Testing**:
  - Architecture boundary validation ensuring no package violates dependency boundaries (e.g., router never imports broker internals; domain dungeons depend only on core contracts).
  - High-coverage unit tests and end-to-end integration flows.
