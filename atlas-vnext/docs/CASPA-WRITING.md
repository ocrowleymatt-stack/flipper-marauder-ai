# Caspa Writing dungeon

First production-quality Atlas dungeon: a thin writing domain over platform primitives. Stacked on the accepted Workbench head (`cursor/vnext-workbench-ui-99e9` @ `7860c42`), which already contains tools/auth and current `main` (projects/files/CAS).

## Ownership

Caspa **may** own writing task semantics, document workflows, writing instructions, the unified writing operation, document/version presentation, writing-specific context rules (selected files only), domain UX, and domain metadata.

Caspa **must not** own provider registry/ranking/health/routing, transport/retry/failover, generic tools/Authority/auth/tenancy, generic project/file/CAS/retrieval/provenance/run/RunPod/conversation persistence. Those stay platform services. Caspa consumes them.

## Registration

`CASPA_WRITING_DUNGEON` is a small record: identity `writing` / slug `caspa`, routes, capabilities, nav label, domain surface `caspa-writing`, permissions (`artifact.read` / `artifact.write`), feature availability. `GET /api/dungeons` lists it. This is not a marketplace.

## Document / version model

Documents belong to **tenant + project**. There is no parallel Caspa workspace tree.

| Field | Notes |
|---|---|
| Identity | `documents.id` / `urn:atlas:document:…` |
| Project | `workspace_id` |
| Title | mutable metadata |
| Current content | CAS blob via `current_artefact_id` / `current_content_hash` |
| Timestamps | created/updated |
| Versions | append-only `document_versions` |
| Originating run | `originating_run_id` |
| Provenance | platform `provenance` rows for version artefacts |
| Status | idle → requested → running → streaming → candidate → committed / failed |

Identity is separate from content. Huge blobs stay in CAS. Optimistic concurrency uses `revision`; stale clients receive `stale_revision` / HTTP 409.

## Lifecycle

`requested` → `running` → `streaming` (draft persisted, not canonical) → `candidate` → **committed revision** on success.

A half-streamed failure is **not** committed as the current document. Draft + classified failure are preserved. After visible output the run is sealed; continuation is a new generate. Process restart marks in-flight documents `failed` / `interrupted` without promoting the draft.

## Behaviour composition

Precedence (testable, later layers refine the task and cannot strip earlier safety):

1. capabilityPolicy
2. runtimePolicy
3. behaviourPosture (Open/Standard — not Authority)
4. dungeonWritingBehaviour
5. projectContext (selected files / retrieval slices)
6. requestInstructions (operation + user instruction + current document)

Prompts live in `dungeons/writing/src/behaviour.ts`, not in the UI or HTTP handlers. Open Behaviour does not grant `artifact.write` or tools.

## Context

Caspa passes `restrictFileIds` into platform `ContextService`. Empty selection means no files, not dump-all. Missing or cross-tenant file ids fail closed as `file_missing` / `file_unauthorized`.

## Provenance

Backend-derived: selected files, chunks, prior revision hash, run id, route/model (via the execution spine), tools if invoked. The UI renders `GET /api/documents/:id/provenance`; it does not infer sources.

## Authority

Server-side `AuthorityEngine.decide` on actor + tenant + resource + action. Buttons, frontend flags, and guessed ids are not permission. Cross-tenant reads/mutations return generic `Permission denied.`

## Workbench

Caspa mounts through the generic dungeon seam (`Writing` surface). Workbench is not forked and does not grow manuscript types. Domain surface: document list, editor/view, instruction, file selection, generation state, versions, provenance, classified errors, and the existing tool/approval inspector when a run invokes tools.

## Provider-neutral execution

Caspa expresses **requirements** (context tokens, tools, reasoning, quality, latency, privacy, capability alias). Nexus decides WHERE. Execution decides HOW. Caspa contains no SDKs, streaming loops, retries, circuit breakers, failover, or RunPod. Failover remains an Execution invariant: only before visible output.

## Operations

One `POST /api/documents/:id/generate` with `operation`: create, rewrite, shorten, expand, tone, restructure, correct, continue, transform. Restore is `POST /api/documents/:id/restore` and writes a **new** version. Continue is a document revision, not a chat-only turn.

## Migration status

See the table in this PR’s report and [WRITING-MODEL.md](./WRITING-MODEL.md). Acceptance is a useful durable secure platform-native Writing dungeon E2E, not historical Caspa parity.
