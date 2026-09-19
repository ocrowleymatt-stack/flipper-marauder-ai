# Wave 3 recovery — Atlas experience / UI convergence

DO NOT MERGE until Owner Delegate review.
DO NOT DEPLOY.
Public production must remain on `68603a465f39ff20804f221b5db6e3faf1cdfb11`.

Accepted development baseline: `09d8b91a3ecc1012016e2f4b42a18f7584eca5dd` (Wave 2).
This tranche converges the visible product on Atlas, not Workbench.

Workbench remains Advanced / Run details. It is not the primary product.

## Two verdicts (do not conflate)

| Gate | Verdict | Meaning |
|---|---|---|
| WAVE 3 DEFINED-SCOPE GATE | pending exact-head CI + Owner Delegate | Conversation-first Atlas shell, Skills, Library, Projects as workspaces, research/OSINT result cards, collapsible context panel, Advanced/Workbench separation, journeys A–H. |
| OVERALL ATLAS EXPERIENCE SAME-OR-BETTER | FAIL | Not equivalent to the richest predecessor Atlas product surfaces. Website Studio, Caspa intelligence, Music/ACE-Step, Investigation caseboard, and remaining OSINT breadth are not in this tranche. |
| WAVE 3 MERGE GATE | pending Owner Delegate | Not a production cutover. |

Do not describe the entire Atlas product as SAME-OR-BETTER because the shell is conversation-first.

## Lineage

- Branch: `cursor/vnext-wave3-atlas-experience`
- Base: `09d8b91a3ecc1012016e2f4b42a18f7584eca5dd`
- Does not inherit #36 / #37 / #38 / #41
- #41 Website Studio remains PARKED

## Recovery map

| Capability | Current (Wave 2 SHA) | Intended Atlas | Disposition | Acceptance |
|---|---|---|---|---|
| Home | Workbench-titled shell, doctor chip, Run details in chrome | Atlas home, talk first | **refactor** | Journey A; title Atlas; empty “Ask Atlas” |
| Navigation | New Chat / Chats / Projects(create) / Library / Dungeons + Help & Repair | New Chat / Chats / Projects / Library / Skills / Settings | **refactor** | nav-* testids; Skills heading; Help & Repair not primary |
| Conversation | Markdown turns, copy, retry | Same plus result cards; no debug-as-chat | **retain + extend** | user/assistant testids; no Tools heading |
| Composer | Persistent Ask Atlas | Retain | **retain** | composer-* |
| Chat continuity | Snapshot after refresh | Retain | **retain** | Journey A refresh |
| Research presentation | Plain assistant markdown | Card + sources panel + follow-up | **refactor** | Journey B; result-card-research |
| OSINT presentation | Plain assistant markdown; desk scan | Card + finding details + follow-up | **refactor** | Journey C; result-card-osint |
| Projects UX | Create form only; IDs unused as labels | Named workspace list | **refactor** | Journey D |
| Library/Files UX | displayName/path/status | Name, origin, project; hash not primary | **refactor** | Journey E |
| Dungeons UX | Dungeons + Help & Repair | Skills inside Atlas; Help & Repair in Settings | **refactor** | Journey F |
| Rich results | None | OSINT/research cards | **replace** | result-card-* |
| Sources/evidence | Context surface only | Right panel from a card | **refactor** | open-sources / finding-details |
| Context/right panel | Run details only | Finding / sources / file / Run details, collapsible | **refactor** | context-panel; diagnostics still “Run details” |
| Advanced/Workbench | Run details toggle + Doctor chip | Advanced + Settings; doctor not primary | **refactor** | Journey H |
| Responsive | 860px nav overlay | Keep; test 390 | **retain** | Journey H narrower |
| Persistence | Snapshot reload | Retain; sign-out to login | **retain** | Journey G |

## Restored now (Wave 3 scope)

1. Atlas is the product title and empty state. Opening Atlas shows a conversation and a composer.
2. Primary nav: New Chat, Chats, Projects (list + create), Library, Skills, Settings. Help & Repair is not a primary Skill.
3. Conversation remains the dominant workspace. Research and OSINT reports grow result cards in that chat.
4. A finding or source opens a collapsible right panel. Back to chat closes it.
5. Projects are named workspaces. Raw ids are not the label.
6. Library shows file name, origin, and project. Content hashes are not the primary UX.
7. Skills wrap actually registered dungeons. Website / Music / Investigation remain available as working surfaces and are not claimed recovered.
8. Advanced / Run details remains the Workbench inspector. Provider, route, and run id stay there.
9. Existing Wave 1 / Workbench browser contracts are preserved (`workbench-shell`, `diagnostics-toggle`, heading “Run details”, `surface-writing`, `surface-files`, Website).

## Explicitly not in Wave 3

- Website Studio product recovery (#41 remains PARKED)
- Caspa novelist intelligence
- Music / ACE-Step real audio
- Investigation caseboard/share
- OSINT 473-site / SpiderFoot scan expansion
- Full WCAG certification

## Architecture (frozen)

- Nexus owns WHERE. Execution owns HOW.
- No provider failover after visible output.
- Behaviour ≠ Authority.
- Tenant is server-derived. Authority is server-side.
- Dungeons remain thin. React still talks only to `/api/*`.
- Projects / Files / CAS / Context / Provenance remain shared.
- RunPod stop/reconciliation unchanged.

## Capability ledger (BETTER / EQUIVALENT / FAIL only)

| Capability | Verdict | Notes |
|---|---|---|
| Atlas home | BETTER | Atlas-titled conversation workspace; empty state is “Ask Atlas” |
| navigation | BETTER | Projects list, Skills, Settings; Help & Repair off the primary list |
| conversation | EQUIVALENT | Same turn model, typography, copy/retry; result cards added beside answers |
| composer | EQUIVALENT | Persistent Ask Atlas composer unchanged in contract |
| chat continuity | EQUIVALENT | Refresh still restores the thread |
| Research presentation | BETTER | In-chat result card + sources panel; desk remains subordinate |
| OSINT presentation | BETTER | In-chat findings card + evidence panel; desk remains subordinate |
| Projects UX | BETTER | Named workspace list, not a create-only form |
| Library/Files UX | BETTER | Name / origin / project; hashes not primary |
| Dungeons UX | BETTER | Skills inside Atlas; incomplete specialists not claimed finished |
| rich results | BETTER | Structured OSINT/research cards; ordinary chat is not a debug card |
| sources/evidence presentation | BETTER | Right-panel details from a finding/source |
| context/right panel | BETTER | Collapsible; Run details is one mode, not the only mode |
| Advanced/Workbench separation | BETTER | Advanced + Settings; doctor/Help & Repair not primary chrome |
| responsive behaviour | EQUIVALENT | Existing 860px overlay plus 390 viewport journey |
| accessibility fundamentals | EQUIVALENT | Labels, skip link, focus-visible, semantic buttons; not WCAG certified |
| visual coherence | BETTER | One Atlas visual language; less operator chrome on the home path |
| persistence/navigation continuity | EQUIVALENT | Refresh restores; sign-out reaches login. PostgreSQL restart is host-level, not a new UI claim |

## Remaining UI deficits (honest FAIL where still true)

- Website Studio product recovery: **FAIL** (parked #41)
- Caspa advanced writing intelligence: **FAIL**
- Music real audio: **FAIL**
- Investigation caseboard: **FAIL**
- Overall OSINT same-or-better: **FAIL** (Wave 2 ledger unchanged)
- Full WCAG certification: **FAIL** (not tested)

## Tests

- `apps/web/src/results.test.ts`
- `apps/host/tests/wave3.browser.test.ts` (`ATLAS_BROWSER_TEST=1`)
- Existing `workbench.browser.test.ts` and `wave1.browser.test.ts` must still pass

Do not deploy. Do not change public production.
