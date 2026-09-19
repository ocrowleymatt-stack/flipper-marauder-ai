# Atlas Workbench

Implemented behaviour for the first production-quality Atlas Workbench vertical slice. The web app at `apps/web` is the primary human interface. It renders host state; it is not Authority, Nexus, Execution, a file store, or a second permission system.

Lineage: this tranche stacks on tools/auth (`cursor/vnext-tools-auth-platform-99e9`) and current `main` (projects/files/CAS). It does not use `cursor/vnext-workbench-persistence-constraint-dbf8`.

## Trust boundary

```text
Browser (apps/web)
  → HTTP/SSE + session cookie + CSRF
Host (apps/host)  composition root
  → session principal (never a client tenant id)
  → ProjectService / FilesService / ContextService / ConversationRuntime / ToolEngine / AuthorityEngine
```

- The UI talks only to `/api/*`. It does not import Nexus, Execution, persistence, or provider SDKs.
- Tenant is derived from the **session**. `POST /api/session` in local/dev issues a cookie for the host principal. A body `tenantId` that does not match the host tenant is rejected. Production bootstrap is refused.
- Guessed project, file, conversation, execution, or tool ids return generic not-found / `Permission denied.` Cross-tenant cookies cannot list or mutate another tenant's projects, files, tools, or the host conversation spine.
- CSRF (`x-atlas-csrf`) is required for mutating cookie requests. Button visibility is not permission.
- Local file-mode hosts without platform persistence expose conversations only; project/file/context routes return `503` with `projects_unavailable` / `files_unavailable`.

## Conversation-first shell

The default experience is a persistent AI workspace. A person should see where to type, watch Atlas work, read the answer in the centre, continue the thread, and still have that answer after refresh.

- **Left:** New conversation, conversation list (title + timestamp on separate lines), project Files / Context / Caspa, then Tools / Dungeons.
- **Centre:** the thread. User and Atlas turns are distinct. Markdown, copy, retry, and Stop are on the thread. The composer stays at the bottom.
- **Run details:** closed until opened. Execution ids, capability aliases, route dumps, and provider internals live there — not ahead of the answer.
- Capability aliases render as Fast / Reason / Code behind More options. Stop cancels the in-flight execution. Retry resubmits the last user turn after a failure.
- Doctor is a compact Healthy / Attention / Problem chip. Optional Ollama trouble is Attention, not “Atlas is broken”.

The live missing-output defect on `ace41a2` is documented in [release/VISIBLE-OUTPUT-ROOT-CAUSE.md](./release/VISIBLE-OUTPUT-ROOT-CAUSE.md).

## Authority

Workbench never evaluates grants. Approve/deny POST to `/api/tools/:id/approve|deny`. The tool engine validates schema, consults Authority, and records the durable decision. Open Behaviour is not sent by the UI and would not grant anything if it were.

Risk, required capabilities, argument summaries, and resource labels on the approval card come from `ToolEngine.present` (server). The browser does not invent them.

## Run lifecycle

1. Authenticated session
2. Create/open a **project** (server-authorised workspace)
3. Create/open a **conversation** bound to that project
4. Submit a turn → Nexus **WHERE** → Execution **HOW** → SSE
5. Optional tools: proposed → validated → authorised → (approval) → execute → provenance
6. Files attach into context assembly; citations are backend `sourced` or honest `unknown`

Statuses the UI can show: Ready, Generating…, Completed, Failed, Stopped, Waiting for approval. After visible assistant output, `applyStream` seals the response. A later provider is not painted as continuation of the same reply.

Reload calls the same GET endpoints. Remounting the SPA does not reset PostgreSQL/memory/CAS state.

## Approval UX

`GET /api/approvals` and conversation tool lists. The card shows action, human-readable args, resource, run, and backend risk. Approve/deny keep the session cookie and CSRF header. There is no manufactured approval token.

## Files, context, provenance

- Upload is `POST /api/projects/:id/files` (`{ path, text }` or multipart). The response is metadata + content hash. **No blob bytes** are returned to the browser.
- Attach: `POST /api/files/:id/attach` with `conversationId`.
- Context: `GET /api/projects/:id/context` — slices and citations from `ContextService`. The UI maps those records; it does not infer provenance in the browser.

## Dungeon extension point

Tools / dungeons (Website, OSINT, Music, Privacy, Help & Repair) and Caspa mount as secondary surfaces with an obvious Back to conversation control. They must not hijack the default workspace. Privacy & Safety is owner-only and still enforced by Authority. Workbench is not forked. See [CASPA-WRITING.md](./CASPA-WRITING.md) and [CASPA-PARITY.md](./CASPA-PARITY.md).

## Non-goals (this slice)

- A second Nexus, Execution, frontend tool runtime, frontend permission gate, or parallel file store
- Copying Mountain's layout as a template
- Production password/OIDC login (local bootstrap only; production fails closed)
- Per-request multi-tenant conversation runtime in one process (the conversation spine is bound at compose time; a mismatched session tenant is fail-closed)
- OCR, embeddings-as-primary-retriever, or exposing GPU vendor/keys/raw infra in the inspector
