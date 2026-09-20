# Caspa parity matrix

Caspa is the reference Atlas dungeon. Useful previous capability is restored through shared platform services. Caspa does not own providers, auth, persistence, retrieval, or execution.

| Legacy surface | Classification | vNext restoration |
|---|---|---|
| Manuscript identity + immutable revisions + conflict | MIGRATED | `documents` / `document_versions` + `stale_revision` |
| One Book Project | MIGRATED | tenant + `platform/projects` |
| Selected-file grounding | MIGRATED | `restrictFileIds` into `ContextService` |
| Craft / writing instructions | MIGRATED | Behaviour layers in `dungeons/writing` |
| Job / artefact provenance | MIGRATED | platform provenance; UI renders only |
| Server-side permission | MIGRATED | `AuthorityEngine` |
| Streaming generate | MIGRATED | ConversationRuntime + host SSE |
| Complete-draft persistence | MIGRATED | draft then committed revision; editor `edit` commits user text |
| Version history / restore | MIGRATED | versions + restore as a new revision |
| Cancellation | MIGRATED | `POST /documents/:id/cancel` + runtime.cancel |
| Resumability after reload | MIGRATED | GET document/versions/provenance; browser is not source of truth |
| Long-form commission jobs | RESTORED | `writing.commission` via jobs `waitForRuntime` / `resumeFromRuntime` |
| Outline / StoryBible / claims / quality companions | RESTORED | document-scoped `dungeon_records` kinds `outline`, `canon`, `claims`, `quality` |
| Project StoryBible live canon | RESTORED | project `dungeon_records` kind `story_bible`; assembled into later generate with caps |
| Deterministic chapter structure | RESTORED | pure `detectChapters`; persisted by title, not index |
| Conversation result-return | RESTORED | `WritingService.maybeRunFromConversation` on the requesting Atlas conversation |
| Writing result cards | RESTORED | `ResultKind` `writing`; Open manuscript |
| Library manuscript | RESTORED | Files row bound to the writing artefact; origin Generated from provenance |
| Quality heuristics | RESTORED | hard-block unusable output; advisory/corrective otherwise; findings visible |
| User-requested Gold refine | RESTORED | single Execution pass (`refine`); not an autonomous five-call pipeline |
| Multi-round operations | MIGRATED | generate operations including `outline`, `continue`, `edit`, `refine` |
| Failure recovery | MIGRATED | classified failure on document; draft not promoted |
| Caspa routers / llmRouter / failover | DROPPED | Nexus WHERE + Execution HOW |
| GoldPipeline / PlotArchitect copied services | DROPPED | behavioural lessons only; optional user-requested `refine` uses Execution |
| Parallel Caspa/Shakespeare DBs | DROPPED | one documents table + CAS |
| Firebase / Authentik / nginx identity | SUPERSEDED | platform auth + Authority |
| Research / OSINT / music / website inside Caspa | MOVED | specialist dungeons |
| Google Docs live collab | DROPPED | optimistic concurrency |
| Embeddings as primary retriever | DEFERRED | lexical `platform/context` |
| Provider SDKs inside Caspa | FORBIDDEN | never restored |

Acceptance is a demanding writing workload on Atlas infrastructure, not historical UI cloning.
