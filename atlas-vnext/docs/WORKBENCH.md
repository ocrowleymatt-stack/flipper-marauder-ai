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

Statuses the UI can show: queued, running, completed, failed, interrupted/cancelled, awaiting approval. After visible assistant output, `applyStream` seals the response. A later provider is not painted as continuation of the same reply.

Reload calls the same GET endpoints. Remounting the SPA does not reset PostgreSQL/memory/CAS state.

## Approval UX

`GET /api/approvals` and conversation tool lists. The card shows action, human-readable args, resource, run, and backend risk. Approve/deny keep the session cookie and CSRF header. There is no manufactured approval token.

## Files, context, provenance

- Upload is `POST /api/projects/:id/files` (`{ path, text }` or multipart). The response is metadata + content hash. **No blob bytes** are returned to the browser.
- Attach: `POST /api/files/:id/attach` with `conversationId`.
- Context: `GET /api/projects/:id/context` — slices and citations from `ContextService`. The UI maps those records; it does not infer provenance in the browser.

## Dungeon extension point

The shell is generic: project nav, conversation/run, files/context, tools/approval, run inspection. Caspa/Writing mounts as a project-scoped surface (`Writing`) via dungeon registration (`GET /api/dungeons`). Workbench is not forked; manuscript types are not baked into the generic conversation thread. See [CASPA-WRITING.md](./CASPA-WRITING.md).

## Non-goals (this slice)

- Broad Dungeon migration or Investigation product UI
- A second Nexus, Execution, frontend tool runtime, frontend permission gate, or parallel file store
- Copying Mountain's layout as a template
- Production password/OIDC login (local bootstrap only; production fails closed)
- Per-request multi-tenant conversation runtime in one process (the conversation spine is bound at compose time; a mismatched session tenant is fail-closed)
- OCR, embeddings-as-primary-retriever, or exposing RunPod/keys/raw infra in the inspector
