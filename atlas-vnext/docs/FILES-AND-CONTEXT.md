# Files, projects, CAS, and context

Implemented behaviour for Atlas vNext projects/workspaces, content-addressed files, extraction, retrieval, and provenance. This is **not** Workbench UI, a Mountain clone, Nexus/Execution redesign, Tools, Caspa, or Dungeon migration.

Product direction: Atlas vNext UX will be a progressive Workbench, substantially better than Mountain. Persistence and files already support persistent projects, conversations that belong to workspaces, first-class durable artefacts, resumable jobs, versioned documents, files/sources/provenance, and contextual assembly. Chat is one surface. Do not implement Workbench UI here.

## Models

| Concern | Implementation |
|---|---|
| Project / workspace | First-class `ProjectService` over tenant-scoped `workspaces` rows. CRUD, archive/restore, logical delete, optimistic `revision`. No lookup without tenant. |
| CAS | SHA-256 filesystem adapter `sha256/<aa>/<bb>/<hash>`. Dedup, hash verify, atomic tmp+rename publish. No PG blobs. |
| File metadata | `files` + `file_versions` (mutable path ref, immutable content hash). |
| Extraction | Port for txt/md/JSON/CSV/PDF(text layer)/DOCX(structure). No OCR. Macros/PDF JS ignored or rejected. |
| Chunking | Deterministic `atlas.chunk` v1 with locators. Unchanged hashes are not re-extracted/re-chunked. |
| Retrieval | Lexical baseline (`tsvector` in PostgreSQL, overlap rank in memory). Embeddings optional, not required. |
| Context | `ContextService.assemble` — token budget, attachment priority, no concat-all-files, truncation flagged. |
| Citations | Slice-backed `sourced` or honest `unknown`. No fabricated sources. |
| Attachments | `attachments` rows to CAS-backed files. Detach does not delete the file. Restart-safe. |
| Artefacts | Existing `artefact_metadata` + CAS bytes; `createVersion` with expected version. |
| Jobs | Existing job engine, type `files.ingest`, dungeon `platform`. |
| Isolation | Tenant + workspace in every adapter. Hash/file id without a tenant-owned ref does not grant bytes. |
| GC | Logical delete drops `cas_refs`. `gcUnreferenced` unlinks CAS only at refcount 0. |

## Invariants

- Nexus = WHERE, Execution = HOW. Context assembly is platform/application.
- PostgreSQL stores hashes, refs, and bounded chunk text for retrieval — never uploaded file bytes.
- Uploads are data. Paths are sanitised. MIME is sniffed.
- Restart: new process, same PG schema + CAS root, reconstructs projects, files, conversations, artefacts, and source-backed context.

Deferred: Workbench UI, embeddings as the primary retriever, OCR, Tools, Caspa, Dungeon migration, production cutover, replacing the RunPod file runtime store.
