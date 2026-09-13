# Eval suites

Placeholders for the suites required by architecture rule 13. Each directory will hold fixtures, oracles and a runner. Nothing here is invoked by Nexus.

Contract tests for route selection and provider failover already live next to the code (`platform/nexus/test`, `platform/execution/test`). These folders are for longitudinal benchmarks with frozen fixtures.

| Suite | Oracle (when implemented) |
|---|---|
| route-selection | Alias → expected capability class on a golden registry |
| provider-failover | No double-answer; classified fall-through |
| retrieval | Relevant chunks, no silent misses |
| citations | Claims map to stored sources |
| writing | Artefact-first, no padded plan-as-chapter |
| code-tasks | Tests pass on generated patch |
| website-studio | Audit + browser QA gates |
| osint-orchestration | Engine coverage, no fabricated search |
| contradiction-detection | Flag inconsistent evidence |
| tool-selection | Required tool chosen; forbidden tool not |
