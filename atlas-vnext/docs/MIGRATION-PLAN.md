# Migration plan

Zero-downtime cutover is a later concern. This repository is a greenfield design gate, not a sidecar inside Atlas Mountain. Product work proceeds **subsystem-by-subsystem after this gate**.

## Phase 0 — this PR

- [x] Census across accessible repos (Caspa, commons, TheBigBrother, Life-os, Shakespeare) with honest AM inaccessibility
- [x] Architecture, boundaries, storage (PostgreSQL + CAS), jobs, nexus, website, writing, OSINT, deploy, backup docs
- [x] Contracts + thin Nexus + execution broker/interfaces
- [x] Platform and dungeon shells; default-deny permissions; job transitions
- [x] Import-graph boundary tests + negative fixture
- [x] Explicit non-port list
- [x] CI: install, lint, typecheck, unit tests, architecture tests, build

## Phase 1 — conversation spine (this PR)

- [x] Conversation create/list/retrieve with durable messages
- [x] Execution lifecycle, streaming, provenance, reload/recovery
- [x] Host HTTP/SSE + workspace UI
- [x] File-backed metadata store matching the PostgreSQL schema target

## Phase 2 — platform durability

- PostgreSQL metadata migrations (replace the local file adapter)
- Job engine with leases and SSE for long-running dungeon work
- Permissions grant persistence
- Auth

## Phase 3 — real adapters (this PR)

- [x] OpenAI, Anthropic, Gemini, Ollama, Venice, xAI/Grok in **execution**
- [x] Forge/Hetzner as one private-hosted inference provider (not a fake placeholder)
- [x] RunPod shared scheduler (one pod, lease/queue/idle-stop/crash recover)
- [x] Runtime health probes writing snapshots into Nexus (Ollama discovery; Forge probe; circuit-breaker snapshots)

The local file metadata store is **not** final; Phase 2 still owes PostgreSQL.

## Phase 4 — first dungeon

Pick one (likely writing or investigation). Port behaviour, not files. No Nexus domain modules.

## Phase 5 — OSINT

`dungeons/osint` behind jobs + contracts. Bridge BigBrother; do not vendor it. Do not embed `who()` in Nexus.

## Phase 6 — shell and ops

Harden `apps/web` / `apps/host`. New deploy path without `/v12`. Auth and multi-user workspace.

## Data (when a legacy instance must be imported)

1. Decode `content_base64` → CAS blobs.
2. Normalise projects to typed records.
3. Map old runners onto `jobs` with status `completed` where finished.
4. Do **not** keep `/v12` or conversation-shaped APIs as the long-term contract.
