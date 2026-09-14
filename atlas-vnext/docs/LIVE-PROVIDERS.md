# Live providers (Tranche 2 / runtime completion)

Atlas talks to real models through **execution adapters**. Nexus still only ranks a declarative catalogue.

## What is implemented

| Provider | Adapter | Protocol | Status |
|---|---|---|---|
| OpenAI | `OpenAICompatibleAdapter` | Chat Completions SSE | Implemented, **fixture-tested** |
| Anthropic | `AnthropicAdapter` | Messages SSE + `input_json_delta` buffer | Implemented, **fixture-tested** |
| Gemini | `GeminiAdapter` | `streamGenerateContent` SSE + functionCall assembly | Implemented, **fixture-tested** |
| Venice | OpenAI-compatible | Chat Completions SSE | Implemented, **fixture-tested** |
| xAI / Grok | OpenAI-compatible (`providerId: xai`) | Chat Completions SSE at `https://api.x.ai/v1` | Implemented, **fixture-tested** |
| Ollama | `OllamaAdapter` | `/api/chat` NDJSON + `/api/tags` | Implemented, **fixture-tested** |
| Forge / Hetzner | `createForgeAdapter` | OpenAI-compatible or Ollama on the private host | Implemented, **fixture-tested**. One provider: `forge`. Hetzner is the host, not a catalogue row. |
| RunPod | `RunPodAdapter` + `RuntimeScheduler` | One shared pod: start/warm/lease/queue/idle-stop | Implemented, **fixture-tested**. Does not start on process boot. |

## Topology

- **Ollama** → local, always-available
- **Forge** → private-hosted inference on Hetzner (OpenAI-compatible `/v1/chat/completions` or Ollama). Not RunPod lifecycle.
- **RunPod** → one scarce on-demand GPU. `RUNPOD_MAX_ACTIVE_PODS` is clamped to 1. Idle shutdown via `RUNPOD_IDLE_SHUTDOWN_SECONDS` (default 120).
- **OpenAI / Anthropic / Gemini / xAI / Venice** → public cloud

Nexus ranks using `locality` (`local | private_cloud | public_cloud`) and `runtimeClass` (`always_available | private_hosted | on_demand | expensive_burst`). It does not open sockets or manage pods. Execution owns transport and RunPod lifecycle.

Accessible historical trees (`Caspa`, commons) show Hetzner as the deploy/SSH host and Ollama / Unified Router as the private inference on that host. TypeScript Atlas Mountain (`compute/`, `runpod-*.mjs`, `deploy/hetzner`) was **not cloneable** this run (`ocrowleymatt-stack/atlas-mountain` 404). Forge and Hetzner are therefore one runtime/provider relationship.

## Secrets

One abstraction: `SecretStore` / `EnvSecretStore` in `platform/execution`. Adapters never read `process.env`. Host injects secrets at composition.

| Secret | Provider |
|---|---|
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | Gemini |
| `VENICE_API_KEY` | Venice |
| `XAI_API_KEY` or `GROK_API_KEY` | xAI / Grok |
| `FORGE_API_KEY` / `ATLAS_FORGE_API_KEY` / `HETZNER_INFERENCE_API_KEY` | Forge (optional on a trusted LAN) |
| `ATLAS_FORGE_BASE_URL` or `ATLAS_HETZNER_INFERENCE_URL` | Forge endpoint (not a secret, required to enable) |
| `RUNPOD_API_KEY` + `RUNPOD_POD_ID` | Existing single RunPod only; Atlas will not create a second pod |
| `ATLAS_OLLAMA_URL` (optional, not a secret) | Ollama endpoint, default `http://127.0.0.1:11434` |

Missing credentials mark the provider **unavailable**. The process still starts.

`ATLAS_USE_MOCK_PROVIDERS=1` forces in-process mocks for local UI work. Mocks are **not** the production path (`apps/host/src/main.ts` defaults to `live`).

## Smoke

```bash
cd atlas-vnext
ATLAS_LIVE_SMOKE=1 OPENAI_API_KEY=... npm run smoke:live
```

Prompt used: `Reply with exactly: ATLAS LIVE`. CI does not require keys. `tests/live` is skipped unless `ATLAS_LIVE_SMOKE=1`.

## Persistence

The file document store remains a **local/dev adapter**. It is not the production system of record. Next durability tranche must move conversations, messages, executions, events, and provenance to PostgreSQL (+ CAS for blobs) behind the existing conversation ports. Execution must stay decoupled from that store. **Do not start PostgreSQL until a live round-trip is proven.**
