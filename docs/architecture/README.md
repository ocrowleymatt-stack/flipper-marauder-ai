# Atlas vNext — Design Gate (source of truth)

This directory is the architectural source of truth for the Atlas vNext rebuild.
It is **not** a copy of Atlas Mountain. Existing Atlas-related repositories are
behavioural references only.

| Document | Purpose |
|---|---|
| [overview.md](./overview.md) | System shape: Nexus, broker, jobs, CAS, events, provenance, capabilities, modules |
| [capability-census.md](./capability-census.md) | What the current systems actually do |
| [port-redesign-discard.md](./port-redesign-discard.md) | Explicit keep / reshape / drop decisions |
| [contracts.md](./contracts.md) | Job, project, event, provenance, permission, storage APIs |
| [monorepo-layout.md](./monorepo-layout.md) | Packages, ownership, dependency rules |
| [design-gate-report.md](./design-gate-report.md) | What was found, what is proposed, what is out of scope |
| [../adr/](../adr/) | Architecture decision records |

**Gate status:** this change *is* the first design gate. No major product code
is implemented. Stubs, schemas, CI, and architecture-boundary tests encode the
boundaries so later gates cannot accidentally rebuild Atlas Mountain.
