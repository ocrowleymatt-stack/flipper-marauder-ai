# Migration plan

vNext is a new system. Migration is **behaviour and data**, not a file copy from Atlas Mountain.

## Phases

### Phase 0 — this PR

Contracts, Nexus, execution skeleton, tests, docs, ops runbooks. No production traffic. No dungeon logic.

### Phase 1 — platform completeness

Implement `platform/{jobs,events,storage,projects,permissions,auth,observability,provenance}` against the contracts. SQLite is an acceptable first store if the CAS API is real (digest in, digest out).

### Phase 2 — shell

`apps/web` with product zones. Conversation SSE using execution broker + fake or one real adapter. Permission prompts. Job panel.

### Phase 3 — one dungeon

Writing **or** Investigation first (Investigation has the best provenance tests; Writing has the best durable-job behaviour). Port *behaviour* from census oracles, rewrite against platform jobs/storage.

### Phase 4 — remaining dungeons

OSINT (merge `@ocrowley/osint` WHO jobs onto platform jobs), Research, Website Studio, Music. Each dungeon PR must add eval placeholders → real evals.

### Phase 5 — cutover

Run vNext beside Mountain. Dual-write projects if needed. Flip DNS only after backup restore drill succeeds on a staging host.

## Data import (when we touch real data)

| Source | Target | Notes |
|---|---|---|
| `projects` rows | `platform/projects` | Preserve ids where UUID; otherwise mint ObjectId and map |
| `conversations` / `messages` | conversation objects | Attach `projectId`; orphaned chats go to an “inbox” project |
| `attachments.content_base64` | CAS blobs | Hash; skip duplicate bytes |
| `artifacts` paths | ObjectRefs + manifests | Path becomes ref, bytes become blob |
| `writing_commissions` | jobs `type=writing.commission` | Map lease/checkpoint JSON as-is when valid |
| `research_jobs` | jobs `type=research.run` | Map engines into checkpoint |
| Investigation tables | dungeon-owned records + CAS | `capture_sha256` → blob digest if bytes exist; else provenance-only |
| Vault secrets | `platform/auth` secrets + `secrets.use` | Never log |
| Permission grants | new scope names | Map `browser.navigate` → `browser.control` (lossy; default ASK for submit) |

Do not import Caspa Firebase documents until a dedicated importer exists. Do not import Shakespeare.

## Compatibility shims (temporary, flagged)

- Alias map: `nexus/instant` → `nexus/fast`, `nexus/private` → `nexus/local`. Behind `flags.mountainAliasShim`.
- Explicit route ids `openai/chat` → `{ providerId: openai, modelId: from registry default }`.

Shims expire; they are not Nexus features.

## Risk register

| Risk | Mitigation |
|---|---|
| Nexus grows domain logic again | Boundary tests: nexus package has no dungeon imports; codeowners |
| Double-answer regressions | Contract test 8 is blocking for any adapter PR |
| Silent fallback on explicit model | Contract test 14 |
| Guest data leak on restore | Restore runbook restores tenant dirs independently; tests later |
| OSINT legal/policy | Dungeon default-deny; `network.public` ASK; case id required (commons lesson) |
| Deploying a green build that cannot boot | `ops/deploy` verify step; rollback pointer |

## Success criteria for calling Nexus “stable”

All items in `docs/NEXUS-CONTRACT.md` contract tests green on CI, Nexus package still has no `fetch` to provider hosts, and no file under `platform/nexus` mentions writing/osint/investigation/website.
