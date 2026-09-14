# @atlas-vnext/execution

Data and transport plane.

**Owns:** provider adapters, HTTP/fetch, stream normalisation, retries, backoff, circuit breakers, transactional tool-call buffering, the secrets port, timeouts.

**Does not own:** route selection, dungeon domain logic, project/CAS persistence.

Production adapters: OpenAI, Anthropic, Gemini, Venice, Ollama, xAI, Forge, and a single shared on-demand RunPod GPU.

RunPod is execution/runtime infrastructure, not Nexus and not a dungeon. One paid pod, started on demand, exclusive lease, durable queue (`waiting_runtime`), idle shutdown via `RUNPOD_IDLE_SHUTDOWN_SECONDS` (default 120). `RUNPOD_MAX_ACTIVE_PODS` is clamped to 1. Keep-warm is an explicit time-bounded override (`RuntimeScheduler.requestKeepWarm`), not an always-on default.

Mocks exist for tests and `ATLAS_USE_MOCK_PROVIDERS=1`. They are not the default runtime path.

See [LIVE-PROVIDERS.md](../../docs/LIVE-PROVIDERS.md).
