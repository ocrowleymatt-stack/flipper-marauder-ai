# Wave 2 recovery — real OSINT

DO NOT MERGE until Owner Delegate review.
Public production must remain on `68603a465f39ff20804f221b5db6e3faf1cdfb11`.

Accepted development baseline: `1ae4fd031eb51fc89f0c82f14d9fb1c1a08a247c` (Wave 1).
This tranche restores genuine bounded public-source OSINT on that spine.

OSINT is restored only when Atlas performs real public-source acquisition,
stores evidence, and returns usable findings to the requesting conversation.
A target row, a DNS stamp, a mock scanner 200, or an LLM dossier is not enough.

## Two verdicts (do not conflate)

| Gate | Verdict | Meaning |
|---|---|---|
| WAVE 2 DEFINED-SCOPE GATE | PASS (pending exact-head CI on this closeout) | The explicitly selected bounded tranche is implemented: 8-site GET+soft-404 presence with defensible positive detection, domain/URL/email/IP public lookups, who()-style orchestration, correlation ≠ observation, CAS/provenance, conversation result-return, Authority/SSRF/bounds. |
| OVERALL ATLAS OSINT SAME-OR-BETTER | FAIL | Not equivalent to the richest useful predecessor OSINT estate. 8/473 TBB sites; PTR-only IP; MX+Gravatar email; SpiderFoot ping-only. |
| WAVE 2 MERGE GATE | pending exact-head CI | GO only if P1s and material P2s on this head are resolved and CI is green. Not a production cutover. |

Do not describe the entire Atlas OSINT estate as SAME-OR-BETTER while username enumeration, IP intelligence, email intelligence, TheBigBrother coverage, or SpiderFoot remain FAIL.

## Architecture (frozen)

- Thin `dungeons/osint` — jobs, records, dossiers, conversation return.
- Host-injected `NodePublicLookup` consumes Wave 1 `SourceInspectPort` + optional search.
- No dungeon `fetch`, `process.env`, `node:dns`, `node:https`.
- No vendoring of TheBigBrother or `@ocrowley/osint` into Nexus or the dungeon.
- Behaviour ≠ Authority. `network.public` + stored EffectivePolicy overlay.
- Private/localhost/mapped-IPv6/local-network/documentation-range targets fail closed through Wave 1 SSRF plus OSINT reserved-address checks.

## Restored now (Wave 2 scope)

1. Username presence on a curated 8-site catalog (GitHub, GitLab, Reddit, HN, Bitbucket, Keybase, Wikipedia, npm) using GET + soft-404, not HEAD and not syntactic validity. **Confirmed** requires HTTP 200 + not soft-404 + URL retains the subject + not login/challenge + subject token in the body (word-bounded). Ambiguous 200 → `likely` / `unknown`, never `confirmed`. Gravatar `d=404` is the one site-specific HTTP-200 presence signal.
2. Domain intelligence: public DNS A/AAAA/NS/TXT, TLS certificate to a public IP with SNI (observed vs chain-validated split), homepage inspect, Wayback CDX via inspect. Private-only / documentation-range A/AAAA fail closed and do not continue into HTTP/TLS.
3. URL acquisition through Wave 1 inspect (SSRF, pin, redirects, size).
4. Email: MX, domain bundle, Gravatar 404-presence. No Holehe/HIBP; guessed address patterns are not observations.
5. IP: PTR on public addresses only; private/reserved/documentation (`192.0.2/24`, `198.51.100/24`, `203.0.113/24`, `2001:db8::/32`) denied.
6. `who()`-style parse including IPv6 literals (`::1`, `2001:db8::1`, IPv4-mapped, public IPv6), username variants (max 4), parallel probes (max 4), dedupe, overall 40s bound that races DNS and throws `aborted` rather than persisting cancelled work as intelligence.
7. Correlation stored separately from observations. Username correlation is unique platforms per handle, not `GitHub, GitHub`.
8. Epistemic kinds: observation / correlation / inference / hypothesis.
9. Deterministic dossier/report. Model does not manufacture evidence.
10. Conversation result-return: “Run OSINT on …” posts the report into that chat; strongest / sources / “open the second one” resolve from durable records and yield when later non-OSINT dungeon work owns the conversation.
11. Optional SpiderFoot ping adapter. Unset URL → **NOT CONFIGURED** (hypothesis, never a fake PASS). A reachable ping is `unknown` / `possible` and does **not** submit scans.
12. Completeness: hypothesis-only output is `insufficient_evidence`. Rate-limit/block/error are not “not found”. Scanner HTTP 200 is not OSINT success.

## Explicitly not in Wave 2 (parity remains FAIL)

- TheBigBrother 473-site Sherlock table and remaining TBB modules
- Recursive critique loop / holehe / maigret / sherlock CLI
- Full SpiderFoot scans (only ping if configured; ping ≠ scan)
- Darkweb / DeHashed / IntelX / HIBP account API
- Port scan, EXIF-by-URL, exploit dorks, GeoIP, RDAP, Shodan
- ACE-Step, GoldPipeline, Website Studio product work, Investigation caseboard

## Predecessor sources inspected

| Repo | SHA |
|---|---|
| ocrowley-commons | `6180d7f0d51d16e78c85d3cfdb34f740edbd960c` |
| TheBigBrother | `3e9569acead32efec755b0baae83922fa05ec5a1` |
| atlas-mountain | `5cc7a964059d3f6583bb5a8284f85185c86f1cb1` |

Predecessor coverage (quality, not raw scanner count):

| Predecessor capability | Wave 2 | Disposition |
|---|---|---|
| commons `who()` parse/variants/parallel/dedupe/report | restored, bounded | valuable; recursive toolkit later |
| TBB/Sherlock 473-site username table | 8 curated high-value sites | remaining 465 LATER; not blindly reproduced |
| Presence via GET+error classification (not HEAD) | restored | HEAD obsolete vs commons `probeBetter` |
| SpiderFoot full scan/job/normalise | ping-only | FAIL until a real adapter submits bounded scans |
| IP GeoIP/RDAP/Shodan/ports | PTR + deny | FAIL; ports UNSAFE |
| Email Holehe/HIBP | MX + Gravatar | FAIL; HIBP EXT |
| Darkweb/DeHashed/IntelX | absent | EXT / unavailable |

The smaller modern username set plus Wave 1 Search/Research is **not** equivalent useful behaviour to 473-site enumeration. Username enumeration overall remains FAIL.

## Capability ledger (BETTER / EQUIVALENT / FAIL only)

| Capability | Verdict | Notes |
|---|---|---|
| username enumeration | FAIL | 8 curated sites restored with defensible positive detection; predecessor 473-site table not in this tranche |
| domain intelligence | EQUIVALENT | DNS + TLS observed/validated split + public web + Wayback CDX; no crt.sh/RDAP/port-scan (port-scan UNSAFE) |
| IP intelligence | FAIL | PTR + SSRF/reserved deny only; no GeoIP/RDAP/Shodan |
| URL intelligence | EQUIVALENT | Wave 1 inspect (SSRF/pin/redirects) is stronger than TBB raw GET |
| email intelligence | FAIL | MX + Gravatar + domain bundle; no Holehe/HIBP account |
| who() orchestration | EQUIVALENT | parse (incl. IPv6), variants, parallel probes, dedupe, 40s aborting deadline, report; no recursive toolkit |
| TheBigBrother scanner coverage | FAIL | 8/473 sites; remaining modules LATER/UNSAFE/EXT |
| SpiderFoot integration | FAIL | ping-only; reachable ping is not a scan; unset is NOT CONFIGURED |
| finding correlation | EQUIVALENT | unique platforms per handle; shared-host correlations; not treated as fact |
| evidence/provenance | BETTER | CAS artefact + content hash + provenance on every material hit |
| dossier | EQUIVALENT | deterministic evidence-backed report; Nexus does not invent sources |
| conversation result-return | BETTER | report + strongest/sources/ordinal follow-ups bound to `conversationId`; yield to later non-OSINT work |
| persistence | EQUIVALENT | dungeon_records + CAS; survives session |
| Authority | BETTER | `network.public` + stored overlay; follow-ups require `artifact.read`; private targets 404 |
| tenant/project isolation | EQUIVALENT | guessed ids 404; workspace-scoped records |
| resource bounds | EQUIVALENT | max 8 sites, 4 variants, parallelism 4, 8s probe, 40s overall; POST `/osint/scans` is generation rate class |
| failure semantics | BETTER | confirmed/likely/negative/error/rate_limited/blocked/unknown distinguished; abort ≠ completed intelligence |
| OSINT UX | EQUIVALENT | Atlas chat is primary; OSINT desk is a subordinate working surface |

## Owner Delegate P1/P2 disposition (this closeout)

| Finding | Class | Disposition |
|---|---|---|
| Generic HTTP 200 / login / challenge false-confirms | P1 | **resolved** — confirmed requires retained subject URL + word-bounded subject in body; login paths unknown; challenge blocked; ambiguous 200 is `likely` |
| Overall 40s deadline must bound DNS; late work must not mutate | P1 | **resolved** — `withDeadline` races DNS; abort throws before SpiderFoot/correlate/persist |
| Username correlations unique platforms | P2 | **resolved** — one row per handle/platform; no `GitHub, GitHub` |
| Private-only DNS fail-closed | P2 | **resolved** — private/documentation-only A/AAAA `blocked`; dungeon 404; mixed public+private uses only public addresses |
| IPv6 conversation parse | P2 | **resolved** — `::1`, `2001:db8::1`, `::ffff:127.0.0.1`, `2606:4700:4700::1111`; reserved examples denied |
| Stale OSINT follow-up vs later work | P2 | **resolved** — yield when any later completed non-OSINT dungeon record owns the conversation |
| TLS `rejectUnauthorized: false` labelled confirmed | P2/MED | **resolved** — unverified presentations are `possible`/`unknown`; evidence stores `authorized` |
| Follow-up Authority | P2/MED | **resolved** — `answerFollowup` calls `requireProject(..., artifact.read)` |
| Scan rate/resource | P2/MED | **resolved** — POST `/osint/scans` is generation rate class; catalog/variant/parallel/timeout bounds remain |

## Tests

- `dungeons/osint/tests/osint.test.ts`
- `apps/host/tests/osint-engine.test.ts`
- `apps/host/tests/wave2-osint.test.ts`
- `apps/host/tests/wave2-osint.live.test.ts` (`ATLAS_WAVE2_LIVE=1`)
- architecture estate: dungeon still has no fetch / `TheBigBrother` / `SpiderFoot` / `node:https` / `node:dns`

## Live public targets (acceptance, isolated)

Observed against public sources (not production). Re-run with `ATLAS_WAVE2_LIVE=1` on this closeout head.

| Target | Result |
|---|---|
| username `octocat` | GitHub profile **confirmed** only with subject-in-body + retained URL (HTTP 200, content hash, canonical URL). Other catalog sites negative/error/blocked distinguished. |
| username `this-user-does-not-exist-atlas-wave2-zzzz` | GitHub **not confirmed** (negative/unknown/likely). Generic 200 must not false-confirm. |
| domain `example.com` | DNS A confirmed; homepage inspect confirmed “Example Domain”; Wayback CDX attempted. |
| domain `wikipedia.org` | DNS A/NS/TXT; TLS `authorized` split; homepage inspect; Wayback CDX. |
| URL `https://example.com/` | Wave 1 inspect **confirmed** HTTP 200, “Example Domain”. |
| email `nonexistent@example.com` | MX observed; Gravatar only confirmed on HTTP 200 `d=404`; no invented account presence. |
| IP `127.0.0.1` / `::1` / `::ffff:127.0.0.1` / `2001:db8::1` | **blocked** (`ip.validate`), not scanned. |
| `networkAccess: none` | server-side denial (404 / Permission denied in chat). |

SpiderFoot: **NOT CONFIGURED** in this environment (hypothesis, not a fake PASS).

Do not use private individuals as acceptance targets.
Do not deploy. Do not change public production.
