# Caspa Novel Machine — Tranche 1

Status: **review only**. Branched from the first accepted public Atlas vNext baseline `68603a465f39ff20804f221b5db6e3faf1cdfb11`. Do not merge or deploy without explicit human approval. Production nginx, DNS, Mountain, ports, and secrets are unchanged.

Caspa is a novelist's persistent writing room. It is not a generic document editor, an evidence manager, a research dungeon, or a chat skin.

## First-class concepts

| Concept | Persistence | Role |
| --- | --- | --- |
| Manuscript | `documents` / `document_versions` + CAS | The novel. Chapters are project documents. |
| Story bible | `dungeon_records` kind `story_bible` | Premise, genre, tone, POV, tense, style, themes, world rules. |
| Characters | `dungeon_records` kind `character` | Name, role, want, need, voice. Selected by name mention. |
| World / setting | `dungeon_records` kind `world` plus bible `settingRules` | Named setting records. Bounded slices in context. |
| Structure | `dungeon_records` kind `structure` | Chapter/scene outline. Nearby chapter tail may be supplied. |
| Continuity / critique | `dungeon_records` kinds `continuity`, `critique` | Findings with explanation and manuscript references. No 0–100 scores. |
| Creative lineage | `dungeon_records` kind `creative_lineage` | Authored revision history. Distinct from evidential provenance. |

No migration 010. Tranche 1 reuses generic `dungeon_records` (`kind` is a free string) and the existing document OCC `revision` / `stale_revision` 409 contract. Schema version stays **9**.

## Surfaces

Manuscript stays central. Secondary surfaces: Story bible (includes world records), Characters, Structure, Continuity. Navigation is chapter/scene list, not a generic file browser.

## Writing operations (Behaviour, not permissions)

Manuscript-mutating: `continue_scene`, `draft_scene`, `rewrite_selection`, `expand`, `tighten`, `tone`, `dialogue`, `description`, `character_voice`, `repair_from_critique`, plus the existing create/rewrite/continue/edit/restore set.

Findings-only (do **not** overwrite manuscript): `continuity_check`, `critique`.

Caspa declares Nexus **aliases** (`nexus/fast`, `nexus/reason`, `nexus/local`). It does not name xAI, OpenAI, or any provider. Nexus owns WHERE. Execution owns HOW.

## Context assembly

Each run receives only relevant slices:

- story bible (capped)
- characters whose names appear in instruction/selection/current text (cap 4; fallback first 4 if none mentioned)
- world records (cap 2)
- structure outline
- nearby previous chapter tail
- open continuity/critique titles
- selected files via shared `ContextService` (`restrictFileIds`; empty means none)
- optional selection passage

The assembled prompt is not the whole novel. A context manifest (kinds, ids, hashes, char counts) is stored on creative lineage so bad writing is diagnosable without leaking secrets.

## Writer → Critic → Repair

Tranche 1 is **explicit**, not autonomous.

- A trivial tighten/tone/continue is one Nexus/Execution run.
- Critique and continuity check are one findings-only run.
- Repair from critique is a separate user-requested manuscript mutation that sees open findings.

No Missions. No automatic four-call pipeline. Future effort escalation may use importance × uncertainty × consequence × reversibility; that platform is out of scope.

## Creative lineage vs evidential provenance

Evidential provenance (`provenance` rows) remains for committed artefacts: selected files, hashes, execution route/model, tools. `create()` still opens a blank manuscript with empty evidential provenance until a revision is committed. Invented prose does not require conventional sources.

Creative lineage records: parent revision, writing operation, context snapshot/refs, execution id, creation time, principal. Findings-only runs record lineage against the current version without adding a `document_versions` row.

Companion notes (`outline` / `canon` / `claims` / `quality`) stay distinct from lineage and novel records.

## Revision safety

Unchanged contract:

- generate/edit/restore write a new version (except findings-only)
- stale `expectedRevision` → `stale_revision` / HTTP 409
- restore writes a **new** version of prior content
- in-flight draft is not canonical; failure does not promote it
- findings-only restore document status to idle/committed and leave `currentVersion`/content unchanged
- tenant isolation and server-side Authority (`artifact.read` / `artifact.write`) remain the gates

## Protected Atlas contracts (unchanged)

- Nexus owns WHERE. Execution owns HOW.
- No provider failover after visible output.
- Behaviour is not Authority.
- Tenant identity is server-derived.
- Authority is server-side.
- Uncertain external side effects require reconciliation.
- Provider implementation details do not leak into Caspa contracts.
- Caspa remains a thin dungeon over Projects, Files/CAS, context, Nexus, Execution, tools, auth, tenancy, Authority.

## Out of scope for Tranche 1

Visual Studio, ComfyUI, RunPod image workflows, video generation, Evidence & Decision Graph, Missions, general adaptive orchestration, OIDC, account administration, broad Workbench redesign, production nginx/DNS/Mountain/port changes, OSINT tranche, Run-details stale `Generating…` chip ([issue #35](https://github.com/ocrowleymatt-stack/flipper-marauder-ai/issues/35)).
