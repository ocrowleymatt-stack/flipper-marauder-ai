# Atlas vNext

Greenfield rebuild of Atlas. **This repository is the only writable target.**

Atlas Mountain, Caspa, ocrowley-commons, Life-os, and related products
are **behavioural references**. They are not architectural templates.
Do not bulk-copy them here.

> Design gate 1 is complete when the documents, contracts, skeleton, and
> architecture-boundary tests in this branch are merged. Product
> implementation starts at later gates.

## Read this first

- [Architecture overview](docs/architecture/overview.md)
- [Capability census](docs/architecture/capability-census.md)
- [Port / redesign / discard](docs/architecture/port-redesign-discard.md)
- [Contracts](docs/architecture/contracts.md)
- [Monorepo layout](docs/architecture/monorepo-layout.md)
- [Design-gate report](docs/architecture/design-gate-report.md)
- [ADRs](docs/adr/)

## Shape (one paragraph)

A thin **Nexus** router emits an `ExecutionIntent`. A separate
**execution broker** is the only place that calls models, tools, or
dungeons. Work is **durable jobs** under **projects**. Bytes live in
**content-addressed storage**. Progress is an **event log**. Assertions
carry **provenance**. Authority is **capability tokens**. Domains are
isolated **dungeons** (including Flipper/Marauder device control).

## Develop

Requires Node 22+.

```bash
npm install
npm test
npm run lint
npm run typecheck
```

CI runs the same commands. Boundary tests fail if Nexus grows domain
logic, dungeons import each other, the broker is bypassed, storage
locators are not content-addressed, permissions are role-shaped at the
execute boundary, or product code depends on Atlas Mountain internals.

## What this repo is not (yet)

It is not the original Flipper Marauder web app (that product is
recorded in the census and reserved as `dungeons/device-marauder`).
It is not a running assistant. Stubs exist only to lock the graph.
