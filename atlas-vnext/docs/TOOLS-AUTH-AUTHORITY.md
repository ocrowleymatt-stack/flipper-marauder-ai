# Tools, plugins, Authority, authentication, secrets, and operations

This is the production backend tranche for Atlas vNext. It does **not** add Generative Workbench UI. The host exposes server-side APIs and state; a later Workbench only **renders** that state.

## Frozen contracts (unchanged)

- **Nexus = WHERE.** Registry, aliases, ranking, capabilities, policy, health/cost/privacy. Not a tool executor.
- **Execution = HOW.** Transport, streaming, retry, failure class, circuit breakers, cancel, execution provenance, **tool-call assembly**. Not routing policy and not Authority.
- Incomplete or fragmented tool calls **must not execute**. Assemble → validate → authorise → execute **once**.
- No silent provider failover after visible assistant output.
- **Behaviour is not Authority.** Open vs Standard never changes grants. Invalid Behaviour fails closed.
- Tenant isolation fails closed. IDs, hashes, paths, CAS pointers, job ids, and tool ids are not authorisation.
- `local_only` / private fail closed (no public leak).
- Plugins cannot bypass Authority or self-grant.
- Side effects: durable idempotency + server-side approval. Restart cannot duplicate uncertain external effects.
- RunPod: maximum one paid pod. **Tool execution does not own RunPod lifecycle.** Stop failure ≠ stopped. No second pod.

## Tool lifecycle

`proposed → validated → authorised → awaiting_approval → queued → running → succeeded | failed | cancelled | denied | uncertain`

- **Read-only:** validate → authorise → execute → provenance. No approval.
- **Side-effect:** validate → Authority → `awaiting_approval` (durable) → later approve/deny on the **same** invocation id → execute once → provenance.
- Denial is fail-closed: no adapter run, generic `Permission denied.` (no existence leak of another tenant’s resources).
- `uncertain` is terminal: an interrupted **uncertain_external** attempt is not retried.

Progress uses the existing **jobs / events** stack. There is no second job framework.

### Approval

Server-side only. Workbench will later render `awaiting_approval` and POST approve/deny.

- Durable suspend; restart leaves the row in `awaiting_approval`.
When a session cookie is present, tool GET/approve/deny use the **session principal and tenant**, not a caller-supplied id. CSRF is required for those mutating cookie requests. Guessing another tenant's invocation id returns a generic denial.
- Binding nonce is stored on the approval row; expiry is enforced.
- Audit: `decidedBy`, `decision`, `decidedAt`.

### Idempotency

Durable key (`toolId + argument hash` or caller key), invocation id, attempt id. Succeeded results are reused. Retryable transport failures (side-effect class `none`) may resume. Uncertain external effects are **never** blindly retried.

### Cancellation

Queued (and pre-running) work can be cancelled. Running work is cancelled only when the adapter confirms stop. Unconfirmed external stop is **not** reported as cancelled.

### Provenance

Tenant, principal, workspace, conversation/run, model execution, tool/version, argument hash, approval id, result/artefact refs, timestamps, outcome, safe external ids, attempts. **No secrets, prompts, or file bodies** in logs or events.

Large results are stored by reference (`resultRef`) for context assembly.

## Plugins

Identity + version, tool list, secret *names*, Authority requirements, health, rate limit, external binding.

- Same execution path and Authority gate as platform tools.
- Unknown or disabled → fail closed.
- Cannot self-grant capabilities not listed on the plugin record.
- This tranche ships one in-process mock connector: `plugin.mock.echo` / `mock.echo` (no paid credentials).

## Authentication

Production-shaped, not a vendor SDK.

| Concept | Rule |
|---|---|
| Principal | user / optional guest / system |
| Membership | tenant + workspace membership is source of truth |
| Claims | caller-supplied tenant ids are **not** membership |
| Session | opaque id, expiry, rotation, revocation |
| CSRF | required for mutating requests that carry the session cookie |
| Origin | validated when an allow-list is configured |
| Cookies | `HttpOnly; SameSite=Lax; Path=/;` + `Secure` in production |

Production fails closed without a session signing secret (`ATLAS_SESSION_SECRET`).

Local/dev file-mode chat keeps working without cookies (existing conversation spine). When a session cookie **is** present, CSRF is enforced.

## Authority

Granular capabilities (conversation / project / file / artefact / `tool.invoke` + `.readonly` + `.external_write` / shell / code / `browser.read` / `browser.submit` / publish / admin / `runtime.use_paid` / `secrets.use`), plus the historical Mountain-compat scopes.

- Resource-scoped. Default deny. No giant `isAdmin`.
- Cross-tenant and missing membership: generic deny, `leakSensitive: false`.
- Open Behaviour does not grant fs / shell / browser-submit / publish / external mutation / admin / paid compute / cross-tenant.

## Secrets

Never in conversation, project, or artefact data. Never sent to models unless a controlled adapter requests a named key. Never logged (redaction is a backstop). Tenant-scoped vault; rotation-compatible; production fails closed if secret infrastructure is missing. Reuses the execution `SecretStore` port. No real credentials are committed.

## Health and recovery

| Endpoint | Meaning |
|---|---|
| `GET /api/health/live` | Process is up. |
| `GET /api/health/ready` | Critical deps (PostgreSQL when configured, CAS, jobs, runtime scheduler). Optional providers are **not** required. `503` when shutting down or a configured critical dep is `error`. |
| `GET /api/health` | Diagnostic summary (`ok` = live). Includes `ready` + `dependencies`. |

Restart reconcile:

- Chat executions still interrupt in-flight model turns.
- Jobs recover expired leases.
- RunPod scheduler semantics unchanged (one pod; stop failure ≠ stopped).
- Tool invocations: `awaiting_approval` kept; `running` + `uncertain_external` → `uncertain` (no retry); other `running` → failed/retryable.

Graceful shutdown: stop accepting new mutating work, stop new tool invokes, release scheduler idle watch, close persistence.

## How UI will consume this later

Workbench (next tranche) should:

1. Render tool invocation status from `GET /api/tools/:id` and SSE `tool.lifecycle` / `tool.result`.
2. Offer approve/deny against `POST /api/tools/:id/approve` and `/deny` (CSRF + session).
3. Never interpret generated UI or Open Behaviour as extra Authority.

## Safety (shell / code / fs / browser / mutation)

Authority first. Path jail (no traversal, no absolute host paths). Env allow-list; platform secrets stripped. Output size + timeout + cancel. Model/UI cannot override required capabilities on the registry.

## Model / tool loop

Execution buffers provider fragments (OpenAI / Anthropic / Gemini). Only structurally complete calls are emitted. Conversation then: validate → Authority → approval → durable execute → structured result → optional model continue with `priorToolResults`. Abandoned pre-visible provider attempts never reach the tool engine (broker only yields tools after a successful attempt). Post-visible failure does not silently switch providers or replay tools.
