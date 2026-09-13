# @atlas-vnext/execution

Data and transport plane.

**Owns:** provider adapters, HTTP/fetch, stream normalisation, retries, backoff, circuit breakers, transactional tool-call buffering, worker leases.

**Does not own:** route selection, dungeon domain logic, project/CAS persistence.

This design-gate ships the broker, circuit breaker, adapter interface, and a mock adapter. Concrete OpenAI/Anthropic/Gemini/Ollama/RunPod adapters are deferred — they must land here, never in Nexus.
