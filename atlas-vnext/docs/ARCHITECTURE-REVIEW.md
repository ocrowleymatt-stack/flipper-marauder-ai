# Atlas vNext Architecture Review (Design Gate)

**Repo under review / the only writable tree:** `flipper-marauder-ai`  
**Canonical branch:** `cursor/atlas-vnext-design-gate-2e35`  
**Base:** `main`  
**Duplicate branches (scrap, not source of truth):** `cursor/atlas-vnext-design-gate-99e9`, `057e`, `6252`, `694c`, `cursor/atlas-vnext-census-arch-e2ed`, `cursor/atlas-vnext-foundation-66f8`, `cursor/atlas-vnext-skeleton-6252`, `cursor/atlas-vnext-8647`

This review is the design gate. It is not a product migration. Old repos are behavioural references.

---

## 1. flipper-marauder-ai is the only repo being modified

**Verified.** All commits and the pull request for this work are in `https://github.com/ocrowleymatt-stack/flipper-marauder-ai`.

Design-gate files live in `atlas-vnext/` so the repository root is not overwritten as if it were Atlas Mountain.

---

## 2. Reference sources inspected this audit

See [CAPABILITY-CENSUS.md](./CAPABILITY-CENSUS.md) inspection table.

Inspected: Caspa, ocrowley-commons, TheBigBrother, Life-os, Shakespeare-, craigs-navigator (out of scope).

**Not accessible:** `ocrowleymatt-stack/atlas-mountain`, `atlas`, `Nexus`, `nexus-backend`, `nexus-dashboard`, `Life`, `spiderfoot-ui`.

**Rejected as false lead:** a pre-cloned `lystrosaurus/atlas-mountain` Java/Spring Boot/MySQL tree, and the `99e9` census that treated that stub as Atlas. The user-authoritative Atlas Mountain estate is TypeScript/Node (`services/nexus`, provider routing, Writing, Website Studio, RunPod, Hetzner, companion). That tree was **not re-opened this run**; dispositions follow the user-specified estate plus accessible Caspa/commons code.

No bulk copy of implementation from any reference.

---

## 3–10. Gate findings

Nexus is registry + data-driven router only. Execution owns transport, retries, circuit breakers, streaming, and the no-double-answer invariant. Platform primitives (including observability and flags shells) do not import dungeons. Architecture tests walk the TypeScript import graph and `package.json` graphs, and a committed negative fixture fails CI when overlaid as Nexus source.

PostgreSQL is the intended transactional metadata store; CAS holds blobs. Jobs have an explicit transition table. Permissions default deny in code.

Website Studio, Writing, OSINT/Investigation/Research, deployment, backup, and transactional outbox are documented, not product-migrated. Dungeon packages remain thin skeletons.

Full non-port list: [WHAT-WE-DELIBERATELY-DID-NOT-PORT.md](./WHAT-WE-DELIBERATELY-DID-NOT-PORT.md).

---

## Residual risks (accepted)

- The TypeScript Atlas Mountain tree was inaccessible this run; AM-specific file paths from the previous 2e35 author were not re-hashed. If that tree differs from the user-specified estate, a follow-up census pass is required — **without** substituting the Java stub.
- Durable PostgreSQL jobs/CAS/auth are unspecified at runtime until a later PR.
- Flipper Zero sources are absent from current `main`.
- Duplicate vNext branches still exist on the remote; they must remain ignored.
