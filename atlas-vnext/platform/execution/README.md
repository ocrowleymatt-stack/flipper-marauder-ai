# @atlas-vnext/execution

Data and transport plane.

**Owns:** provider adapters, HTTP/fetch, stream normalisation, retries, backoff, circuit breakers, transactional tool-call buffering, the secrets port, timeouts.

**Does not own:** route selection, dungeon domain logic, project/CAS persistence.

Production adapters: OpenAI, Anthropic, Gemini, Venice, Ollama. RunPod and Forge/Hetzner are explicit placeholders and must not be treated as live.

Mocks exist for tests and `ATLAS_USE_MOCK_PROVIDERS=1`. They are not the default runtime path.

See [LIVE-PROVIDERS.md](../../docs/LIVE-PROVIDERS.md).
