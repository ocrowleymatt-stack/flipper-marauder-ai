# @atlas-vnext/nexus

Decision plane only.

**Owns:** provider/model registry, capability aliases, routing policy, recorded health snapshots, route traces.

**Does not own:** HTTP/fetch to providers, SSE/NDJSON parsing, retries, circuit breakers, jobs, storage, dungeon logic.

Health is an input (a recorded snapshot). Probing providers is an execution/runtime concern that *writes* health back into the registry; Nexus never opens sockets.
