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

The default experience is a project rail, a dominant conversation, and a composer. A new user should see where to type, where the answer appears, which model is in use, which project/files are active, and whether Atlas is working.

- **Left:** projects, conversations, files as attachments, Writing, and a collapsed More menu (Help & Repair, specialist dungeons).
- **Centre:** the thread. User and assistant turns are distinct bubbles. Long replies scroll inside the thread. Auto-scroll follows new output only while the user is near the bottom.
- **Details:** collapsed until the user opens them, or until approval/failure requires intervention. Execution ids, capability aliases, and route dumps stay behind Advanced.
- Capability aliases render as Fast / Reason / Code. Stop cancels the in-flight execution. Retry resubmits the last user turn after a failure.

The live missing-output defect on `ace41a2` was not an empty SSE stream. A short echo reached the DOM, then sat in a thin strip under Projects / runs / files / tools chrome, with `applyStream` ignoring `assistant.delta` and dropping events when the React view was still null on first send. This tranche keeps the stream assembly honest and makes the thread the product.

## Authority

Workbench never evaluates grants. Approve/deny POST to `/api/tools/:id/approve|deny`. The tool engine validates schema, consults Authority, and records the durable decision. Open Behaviour is not sent by the UI and would not grant anything if it were.

Risk, required capabilities, argument summaries, and resource labels on the approval card come from `ToolEngine.present` (server). The browser does not invent them.

## Run lifecycle

1. Authenticated session (native login in production; local bootstrap in development)
2. Create/open a **project** (server-authorised workspace)
3. Create/open a **conversation** bound to that project
4. Submit a turn → Nexus **WHERE** → Execution **HOW** → SSE
5. Optional tools: proposed → validated → authorised → (approval) → execute → provenance
6. Files attach into context assembly; citations are backend `sourced` or honest `unknown`

Statuses the UI can show: Ready, Working, Done, Failed, Stopped, Needs approval. After visible assistant output, `applyStream` seals the response. A later provider is not painted as continuation of the same reply.

`applyStream` applies `message.delta` and `assistant.delta` (deduplicating the paired runtime events), refuses to overwrite streamed text with an empty placeholder `message`, and can start from a null view so the first send is not dropped. Reload calls the same GET endpoints. Remounting the SPA does not reset PostgreSQL/memory/CAS state.

## Approval UX

`GET /api/approvals` and conversation tool lists. The card shows action, human-readable args, resource, run, and backend risk. Approve/deny keep the session cookie and CSRF header. There is no manufactured approval token. The details rail opens itself when approval is required.

## Files, context, provenance

- Upload is `POST /api/projects/:id/files` (`{ path, text }` or multipart). The response is metadata + content hash. **No blob bytes** are returned to the browser.
- Attach: `POST /api/files/:id/attach` with `conversationId`.
- Context: `GET /api/projects/:id/context` — slices and citations from `ContextService`. The UI maps those records; it does not infer provenance in the browser.
- In the default shell, files are attachments on the project rail rather than a permanent inspector column.

## Dungeon extension point

Writing is a first-class workspace next to Conversation. Specialist dungeons and Help & Repair sit under More. Caspa/Writing and the migrated specialist dungeons still mount as project-scoped surfaces via dungeon registration (`GET /api/dungeons`). Privacy & Safety is owner-only and still enforced by Authority. Workbench is not forked. See [CASPA-WRITING.md](./CASPA-WRITING.md) and [CASPA-PARITY.md](./CASPA-PARITY.md).

## Non-goals (this slice)

- A second Nexus, Execution, frontend tool runtime, frontend permission gate, or parallel file store
- Copying Mountain's layout as a template
- Changing authentication identity, tenant/Authority, Nexus/Execution ownership, failover, production database, nginx, DNS, or Mountain
- Caspa Novel Machine, Evidence Graph, Missions, or OIDC
- Per-request multi-tenant conversation runtime in one process (the conversation spine is bound at compose time; a mismatched session tenant is fail-closed)
- OCR, embeddings-as-primary-retriever, or exposing GPU vendor/keys/raw infra in the default thread
