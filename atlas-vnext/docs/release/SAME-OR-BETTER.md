# SAME-OR-BETTER recovery ledger

**Base kernel:** `68603a465f39ff20804f221b5db6e3faf1cdfb11`  
**Branch:** `cursor/vnext-product-recovery`  
**Rule:** deferred / mock / skeleton / intentionally replaced is FAIL until observable behaviour exists.  
**This tranche does not merge and does not deploy.**  
**Overall verdict: NO-GO.**

Predecessor SHAs audited (read-only clones, unmodified):

| Repo | SHA |
|------|-----|
| atlas-mountain | `5cc7a964059d3f6583bb5a8284f85185c86f1cb1` |
| Caspa | `55ea40911eee5e62d568f0e22f9c74fab1279229` |
| ocrowley-commons | `6180d7f0d51d16e78c85d3cfdb34f740edbd960c` |
| TheBigBrother | `3e9569acead32efec755b0baae83922fa05ec5a1` |
| Shakespeare- | `f44a746e8acb53be18e7a1a2d8ca0e6cb374d790` |
| novel-machine | `aa5b331cac14f70941d64db4ecc1779428317c2d` |
| Nexus | `6d6c2ea558dd424ba6170fdf1d3d77a7119de97c` |
| nexus-backend | `9b40bb8c29e9537c270db9aac363dd9e1081e485` |
| spiderfoot-ui | `555a4dba00c7afd8609de8557446ccb58a13db9e` |
| atlas | `b79d4bc33a744f047af8b12378f41a810f03d51d` |

Verdicts are only **BETTER**, **EQUIVALENT**, or **FAIL**. Mixed predecessor capability is FAIL until the full observable predecessor behaviour exists.

## Ledger

| CAPABILITY | PREDECESSOR | PREDECESSOR OBSERVABLE | vNEXT IMPLEMENTATION | CURRENT OBSERVABLE | AUTOMATED TEST | BROWSER/E2E | VERDICT |
|---|---|---|---|---|---|---|---|
| Conversation persist / refresh | atlas-mountain ChatView | Messages survive reload | conversation runtime + PG/memory | Messages persist | workbench tests | not re-run this tranche | EQUIVALENT |
| Anaphora in-thread | AM chat history | Dog-name recall from messages | Full thread sent to Nexus | In-thread recall from history | runtime history | not re-run this tranche | EQUIVALENT |
| Dungeon results in requesting chat | AM dungeons share conversation | Findings/audio appear in the asking thread | `postNotice` + conversationId on research/OSINT/music | Assistant notice with sources/player | research/music tests | not re-run this tranche | EQUIVALENT |
| Atlas primary UI | AM three-zone shell | Chat is default; dungeons overlay | New chat / Chats / Library / Dungeons; Workbench secondary | Labels and default surface | App.tsx | not re-run this tranche | EQUIVALENT |
| Workbench secondary | AM right control plane | Provider/jobs/diagnostics not primary | Run details / Help & Repair under Workbench | Hidden by default | App.tsx | n/a | EQUIVALENT |
| Multi-engine web search | AM `research.search` Brave+Kagi+Exa+SearXNG RRF | Real web hits, canonical URLs, coverage | `platform/search` RRF + Wikipedia + DuckDuckGo + optional Brave | Mock fixture engines; live Wikipedia/DDG/Brave | search.test.ts | not re-run | FAIL |
| URL canonicalise / RRF / coverage | AM research.search fusion | Dedup, rank, coverage stop | `canonicalUrl`, `fuseEngineHits`, coverage | Unit-tested | platform/search tests | n/a | EQUIVALENT |
| Agentic research loop | AM ≤10 iter + coverage-gated extra wave + durable job `web→spiderfoot→bigbrother→arcanum` | First search can be inadequate; OSINT stages run | ResearchService two-wave loop + inspect + contradictions | Second wave when coverage gaps; no spiderfoot/bigbrother/arcanum | research.test.ts | not re-run | FAIL |
| Source inspect | AM `web.fetch` | Live page excerpt | Host `inspect` + `browser.navigate` live GET | Live in production mode | host search inspect | n/a | EQUIVALENT |
| Production tool mocks | AM live tools | No Alpha/Beta mock on product path | `retrieval.search` adapter uses federated search in compose | Fixture in mock host; live engines in live host | live-tools + catalogue | n/a | BETTER |
| Contradiction / strongest finding | AM research specialists | Gaps and conflict | `detectContradictions`, `strongestHit` | Unit-tested | platform/search tests | n/a | EQUIVALENT |
| OSINT public lookup | commons `who()`, TBB username enum | Confirmed/likely/possible hits with URLs | Host lookup: DNS + Wikipedia + HTTP document + 3 username probes | Findings with source/confidence/url | osint + collectors | not re-run | FAIL |
| OSINT persistence | vNext target→finding→CAS | Durable findings | Unchanged + conversation notice | Persist + reopen | osint tests | n/a | BETTER |
| Music playable audio | ACE-Step 1.5 RunPod wav/flac/mp3 | Playable GPU track | Local stereo WAV audition required for COMPLETED; optional ACE-Step URL | WAV in CAS + inline player; GPU ACE-Step not restored | music tests | not re-run | FAIL |
| Audio MIME | AM wav/flac/mp3/m4a/aac/ogg/opus | Upload and play | ALLOWED_MIME_TYPES includes those | Sniff WAV | mime-path.test.ts | n/a | EQUIVALENT |
| Caspa novelist intelligence | GoldPipeline, StoryBible, PlotArchitect, wound/desire/mask | Literary engine, not CRUD | HOLD — kernel writing records only | Records without gold/plot-hold | none this tranche | n/a | FAIL |
| Website Studio | AM persistent sites + Playwright QA | Studio product | Thin generate/preview only | Existing website dungeon | website tests | n/a | FAIL |
| Evidence Graph / Missions | later vNext / AM investigation extras | Product surfaces | HOLD | Absent | n/a | n/a | FAIL |
| Visual Studio | AM website/studio product extras | Dedicated studio | HOLD | Absent | n/a | n/a | FAIL |
| Authority / tenant isolation | vNext kernel | Server-derived tenant | Unchanged | Generic 404 deny | estate/osint tests | n/a | EQUIVALENT |
| Chat tools from composer | AM tools in chat | Model can search | Client `tools: true`; Privacy overlay can still disable | live-tools still enforces policy | live-tools.test.ts | n/a | EQUIVALENT |
| Logout/login persistence of dungeon artefacts | AM durable workspace | Findings/audio survive session | Kernel CAS/PG + conversation notices | Unit persistence; browser relogin not re-run | files/osint/music tests | not re-run | FAIL |
| Cross-turn “those findings / that track” after dungeons | AM conversation + artefacts | Anaphora to dungeon outputs | Notices bind findings/artefact ids into the thread | In-thread notice text; no browser journey this tranche | research/music tests | not re-run | FAIL |

## FAIL items that keep overall NO-GO

1. Caspa GoldPipeline / StoryBible intelligence / plot hold / character forge (HOLD, not this base).
2. Full OSINT `who()` + TheBigBrother 21-module / 473-site scanner (not vendored, not restored).
3. Dedicated ACE-Step GPU render lane (audition WAV is real audio; GPU is not).
4. Kagi + Exa + SearXNG engines (Brave optional; Wikipedia + DuckDuckGo are live).
5. Research durable job `web → spiderfoot → bigbrother → arcanum`.
6. Website Studio product (audit, Playwright QA, `/dev/<slug>/`).
7. Visual Studio, Evidence Graph, Missions.
8. Browser/E2E acceptance and logout/login persistence journeys for this tranche.

## Restored this tranche

- Shared federated search primitives and host engines (Wikipedia, DuckDuckGo, optional Brave).
- Iterative two-wave research with inspect, gaps, contradictions, findings, conversation notice.
- OSINT HTTP/Wikipedia/username probes with URLs on findings.
- Music COMPLETED iff audio bytes; inline player; local stereo WAV audition.
- Production tool path no longer serves Alpha/Beta as federated search.
- Atlas-primary navigation; Workbench secondary.
- Composer tool opt-in subject to Privacy.

## Architecture preserved

Nexus owns WHERE. Execution owns HOW. No provider failover after visible output. Behaviour and Authority remain separate. Tenant identity is server-derived. Dungeons do not fetch; host injects `FederatedSearchPort` / `AudioRenderPort` / `PublicLookupPort`. RunPod reconciliation, immutable revisions/OCC, and production isolation are unchanged. Public production was not modified.

## Local verification (pre-push)

- `tsc -p tsconfig.json --noEmit` and `tsc -p apps/web/tsconfig.json --noEmit` clean.
- Focused vitest: 22 files / 131 tests passed (search, research, music, osint, host search/live-tools/estate/workbench, mime, tools, conversation, markdown, architecture).
- Browser/E2E product journeys were **not** re-run against public or staging in this tranche.

## Overall verdict

**NO-GO** for SAME-OR-BETTER product recovery.

Architecturally this is still vNext. Functionally Atlas is closer to the predecessor, but not at least as capable across the estate.
