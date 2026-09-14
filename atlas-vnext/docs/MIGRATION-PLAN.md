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

## Phase 1 — platform durability

- CAS + PostgreSQL metadata migrations
- Job engine with leases and SSE
- Permissions grant persistence
- Auth

## Phase 2 — real adapters

- OpenAI, Anthropic, Gemini, Ollama, Venice in **execution**
- Runtime health probes writing snapshots into Nexus

## Phase 3 — first dungeon

Pick one (likely writing or investigation). Port behaviour, not files. No Nexus domain modules.

## Phase 4 — OSINT

`dungeons/osint` behind jobs + contracts. Bridge BigBrother; do not vendor it. Do not embed `who()` in Nexus.

## Phase 5 — shell and ops

New `apps/web`. New deploy path without `/v12`.

## Data (when a legacy instance must be imported)

1. Decode `content_base64` → CAS blobs.
2. Normalise projects to typed records.
3. Map old runners onto `jobs` with status `completed` where finished.
4. Do **not** keep `/v12` or conversation-shaped APIs as the long-term contract.
