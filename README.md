# Atlas vNext

Greenfield rebuild of Atlas.

> Atlas Mountain is a behavioural reference, not an architectural template.

This repository is intentionally starting from a clean architectural foundation. Existing Atlas-related repositories are reference sources for proven behaviour, contracts, tests and operational lessons; they are not to be copied wholesale.

Initial priorities:

- repository capability census
- architecture and domain boundaries
- durable projects and durable jobs
- event-driven progress
- content-addressed storage
- explicit provenance
- capability-based permissions
- thin Nexus router plus separate execution broker
- plugin-style Dungeons
- built-in observability, evaluation, backup and transactional deployment

Do not bulk-copy implementation from Atlas Mountain or other legacy repositories before the design gate is complete.

## First design gate

This branch contains design artefacts and an intentionally non-functional
monorepo skeleton only:

- [Architecture](ARCHITECTURE.md)
- [Repository audit](docs/REPOSITORY-AUDIT.md)
- [Capability census](docs/CAPABILITY-CENSUS.md)
- [Port/redesign/discard decisions](docs/PORT-REDESIGN-DISCARD.md)
- [Domain boundaries](docs/DOMAIN-BOUNDARIES.md)
- [Nexus contract](docs/NEXUS-CONTRACT.md)
- [Jobs and events](docs/JOBS-AND-EVENTS.md)
- [Storage model](docs/STORAGE-MODEL.md)
- [Migration plan](docs/MIGRATION-PLAN.md)

Run the dependency-free design checks with `npm test`.
