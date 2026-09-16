# Atlas vNext decision ledger

Owner Delegate is the decision authority for this programme. Entries are development-scoped and reversible unless marked otherwise.

| ID | Decision | Alternatives | Chosen | Rationale | Evidence | Reversibility | Affected |
|---|---|---|---|---|---|---|---|
| D1 | Treat `b4388c7` / PR #11 as accepted main | Wait for later main; replay superseded Production Readiness heads | Use current main `b4388c7` | Matches expected Production Readiness merge; contracts preserved | `git log -1` | n/a | programme |
| D2 | Add `privacy` dungeon id + `privacy.view\|configure\|audit` capabilities | Reuse only `admin.configure`; UI-only owner flag | New owner-only capabilities | UI hiding is not security; admin.configure is already a tool id | Authority tests; tool catalogue must not advertise privacy.configure | Additive | contracts, permissions, tools |
| D3 | Generic `dungeon_records` + dedicated privacy tables (migration 008) | Per-dungeon tables; JSON file side stores | One record store + privacy policy/audit/proposals | Smallest shared persistence; dungeons stay thin; privacy is tenant-scoped | Existing documents/sites pattern | Forward migration; no DROP | persistence |
| D4 | Effective policy overlays Authority; cannot grant | Policy as only gate; policy in Nexus | Overlay after Authority ALLOW | Behaviour ≠ Authority; policy must not become a grant path | policy.test.ts | Reversible | permissions |
| D5 | Bootstrap host principal is tenant `owner` | Separate owner account; everyone owner | Compose membership role `owner` for host principal | No OIDC yet; local/dev owner must exist for Privacy dungeon | auth membership.role | Reversible | auth, compose |
| D6 | Step-up for consequential policy = CSRF + `CONFIRM` phrase + audit | Password re-auth; skip step-up | Confirm phrase until OIDC exists | Conservative given no password login in this slice | Privacy service | Reversible | privacy |
| D7 | OSINT sockets live in host collector port | Dungeon `node:https`; copy TheBigBrother | Injected `PublicLookupPort` | Architecture forbids dungeon transport; do not vendor scanners | architecture tests | Reversible | osint, host |
| D8 | Investigation reads OSINT findings via record ids, not dungeon imports | Import osint package; duplicate scans | Persistence records + finding ids | Dungeon isolation | architecture dungeon-isolation | Reversible | investigation |
| D9 | Restore Caspa craft as artefacts/jobs/ops, not GoldPipeline | Port GoldPipeline/StoryBible services | Jobs + related dungeon_records + edit/cancel/commission | Census DROP of routers/GoldPipeline; keep behaviour | Caspa parity audit | Reversible | writing |
| D10 | Stacked PRs; human merge of protected main | Force-push main; one mega-PR | Focused `cursor/vnext-*` PRs, merge order documented | Branch protection; no production cutover | GitHub PR settings | n/a | integration |
| D11 | Website preview via host, never Nexus | Nexus static server | Host GET preview from CAS/site revisions | Frozen Website Studio split | WEBSITE-STUDIO.md | Reversible | website, host |
| D12 | Workbench motion/sound are presentation-only | Encode state only in animation | CSS/Web Audio + reduced-motion + captions | A11y; no Nexus/Execution/Authority change | workbench experience | Reversible | apps/web |
