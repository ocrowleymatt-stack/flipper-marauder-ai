# Live providers (Tranche 2)

Atlas talks to real models through **execution adapters**. Nexus still only ranks a declarative catalogue.

## What is implemented

| Provider | Adapter | Protocol | Status |
|---|---|---|---|
| OpenAI | `OpenAICompatibleAdapter` | Chat Completions SSE | Implemented, **fixture-tested** |
| Anthropic | `AnthropicAdapter` | Messages SSE | Implemented, **fixture-tested** |
| Gemini | `GeminiAdapter` | `streamGenerateContent` SSE | Implemented, **fixture-tested** |
| Venice | OpenAI-compatible | Chat Completions SSE | Implemented, **fixture-tested** |
| Ollama | `OllamaAdapter` | `/api/chat` NDJSON + `/api/tags` | Implemented, **fixture-tested** |
| RunPod | placeholder | none | Not implemented |
| Forge / Hetzner | placeholder | none | Not implemented |

This environment did **not** have live API keys. Do not claim the adapters were live-tested until `npm run smoke:live` has been run with real credentials.

## Secrets

One abstraction: `SecretStore` / `EnvSecretStore` in `platform/execution`. Adapters never read `process.env`. Host injects secrets at composition.

| Secret | Provider |
|---|---|
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | Gemini |
| `VENICE_API_KEY` | Venice |
| `ATLAS_OLLAMA_URL` (optional, not a secret) | Ollama endpoint, default `http://127.0.0.1:11434` |

Missing credentials mark the provider **unavailable**. The process still starts.

`ATLAS_USE_MOCK_PROVIDERS=1` forces in-process mocks for local UI work. Mocks are **not** the production path (`apps/host/src/main.ts` defaults to `live`).

## Smoke

```bash
cd atlas-vnext
ATLAS_LIVE_SMOKE=1 OPENAI_API_KEY=... npm run smoke:live
```

CI does not require keys. `tests/live` is skipped unless `ATLAS_LIVE_SMOKE=1`.

## Persistence

The file document store remains a **local/dev adapter**. It is not the production system of record. Next durability tranche must move conversations, messages, executions, events, and provenance to PostgreSQL (+ CAS for blobs) behind the existing conversation ports. Execution must stay decoupled from that store.
