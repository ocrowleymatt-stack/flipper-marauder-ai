# Atlas vNext design documents

Index of the documents that make up the design gate. Each is owned by a separate workstream;
unlinked entries have not been written yet.

| Document | Purpose |
| --- | --- |
| `CAPABILITY-CENSUS.md` | What Atlas Mountain and other legacy repositories actually do today: behaviours, contracts, tests and operational lessons worth keeping |
| `DOMAIN-BOUNDARIES.md` | The domains (apps, platform, dungeons, runtimes, packages), what each owns, and the dependency rules enforced by `npm run boundaries` |
| `STORAGE-MODEL.md` | Content-addressed blobs and manifests, projects, revisions, and how durable state lives under `ATLAS_DATA_DIR` |
| `JOBS-AND-EVENTS.md` | Durable jobs (checkpoints, retry, cancellation, resume) and the event backbone that reports their progress |
| `NEXUS-CONTRACT.md` | The thin router: capability aliases, model descriptors, route requests/decisions/traces, and the split from the execution broker |
| `MIGRATION-PLAN.md` | How behaviour moves from legacy repositories into vNext without copying their architecture |

The runtime contracts these documents describe are implemented in
[`packages/contracts`](../packages/contracts/README.md).
