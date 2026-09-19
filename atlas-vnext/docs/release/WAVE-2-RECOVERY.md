# Wave 2 recovery — real OSINT

DO NOT MERGE until Owner Delegate review.
Public production must remain on `68603a465f39ff20804f221b5db6e3faf1cdfb11`.

Accepted development baseline: `1ae4fd031eb51fc89f0c82f14d9fb1c1a08a247c` (Wave 1).
This tranche restores genuine bounded public-source OSINT on that spine.

OSINT is restored only when Atlas performs real public-source acquisition,
stores evidence, and returns usable findings to the requesting conversation.
A target row, a DNS stamp, a mock scanner 200, or an LLM dossier is not enough.

## Architecture (frozen)

- Thin `dungeons/osint` — jobs, records, dossiers, conversation return.
- Host-injected `NodePublicLookup` consumes Wave 1 `SourceInspectPort` + optional search.
- No dungeon `fetch`, `process.env`, `node:dns`, `node:https`.
- No vendoring of TheBigBrother or `@ocrowley/osint` into Nexus or the dungeon.
- Behaviour ≠ Authority. `network.public` + stored EffectivePolicy overlay.
- Private/localhost/mapped-IPv6/local-network targets fail closed through Wave 1 SSRF.

## Restored now (Wave 2 scope)

1. Username presence on a curated 8-site catalog (GitHub, GitLab, Reddit, HN, Bitbucket, Keybase, Wikipedia, npm) using GET + soft-404, not HEAD and not syntactic validity.
2. Domain intelligence: public DNS A/AAAA/NS/TXT, TLS certificate to a public IP with SNI, homepage inspect, Wayback CDX via inspect.
3. URL acquisition through Wave 1 inspect (SSRF, pin, redirects, size).
4. Email: MX, domain bundle, Gravatar 404-presence.
5. IP: PTR on public addresses only; private/reserved denied.
6. `who()`-style parse, username variants (max 4), parallel probes (max 4), dedupe, overall 40s bound.
7. Correlation stored separately from observations (same username on ≥2 sites; shared host).
8. Epistemic kinds: observation / correlation / inference / hypothesis.
9. Deterministic dossier/report. Model does not manufacture evidence.
10. Conversation result-return: “Run OSINT on …” posts the report into that chat; strongest / sources / “open the second one” resolve from durable records.
11. Optional SpiderFoot ping adapter. Unset URL → **NOT CONFIGURED** (hypothesis, never a fake PASS).
12. Completeness: hypothesis-only output is `insufficient_evidence`. Rate-limit/block/error are not “not found”.

## Explicitly not in Wave 2 (parity remains FAIL)

- TheBigBrother 473-site Sherlock table and remaining TBB modules
- Recursive critique loop / holehe / maigret / sherlock CLI
- Full SpiderFoot scans (only ping if configured)
- Darkweb / DeHashed / IntelX / HIBP account API
- Port scan, EXIF-by-URL, exploit dorks
- ACE-Step, GoldPipeline, Website Studio product work, Investigation caseboard

## Predecessor sources inspected

| Repo | SHA |
|---|---|
| ocrowley-commons | `6180d7f0d51d16e78c85d3cfdb34f740edbd960c` |
| TheBigBrother | `3e9569acead32efec755b0baae83922fa05ec5a1` |
| atlas-mountain | `5cc7a964059d3f6583bb5a8284f85185c86f1cb1` |

## Capability ledger (BETTER / EQUIVALENT / FAIL only)

| Capability | Verdict | Notes |
|---|---|---|
| username enumeration | FAIL | 8 curated sites restored; predecessor 473-site table not in this tranche |
| domain intelligence | EQUIVALENT | DNS + TLS + public web + Wayback CDX; no crt.sh/RDAP/port-scan (port-scan UNSAFE) |
| IP intelligence | FAIL | PTR + SSRF deny only; no GeoIP/RDAP/Shodan |
| URL intelligence | EQUIVALENT | Wave 1 inspect (SSRF/pin/redirects) is stronger than TBB raw GET |
| email intelligence | FAIL | MX + Gravatar + domain bundle; no Holehe/HIBP account |
| who() orchestration | EQUIVALENT | parse, variants, parallel probes, dedupe, report; no recursive toolkit |
| TheBigBrother scanner coverage | FAIL | 8/473 sites; remaining modules LATER/UNSAFE/EXT |
| SpiderFoot integration | FAIL | ping-only; unscanned instance is NOT CONFIGURED |
| finding correlation | EQUIVALENT | observations stored; correlations separate; not treated as fact |
| evidence/provenance | BETTER | CAS artefact + content hash + provenance on every material hit |
| dossier | EQUIVALENT | deterministic evidence-backed report; Nexus does not invent sources |
| conversation result-return | BETTER | report + strongest/sources/ordinal follow-ups bound to `conversationId` |
| persistence | EQUIVALENT | dungeon_records + CAS; survives session |
| Authority | BETTER | `network.public` + stored overlay; private targets 404 |
| tenant/project isolation | EQUIVALENT | guessed ids 404; workspace-scoped records |
| resource bounds | EQUIVALENT | max 8 sites, 4 variants, parallelism 4, 8s probe, 40s overall |
| failure semantics | BETTER | confirmed/negative/error/rate_limited/blocked/unknown distinguished |
| OSINT UX | EQUIVALENT | Atlas chat is primary; OSINT desk is a subordinate working surface |

Wave 2 SAME-OR-BETTER for the **defined Wave 2 scope** can be GO while the overall Atlas OSINT estate remains FAIL on the rows above.

## Tests

- `dungeons/osint/tests/osint.test.ts`
- `apps/host/tests/osint-engine.test.ts`
- `apps/host/tests/wave2-osint.test.ts`
- `apps/host/tests/wave2-osint.live.test.ts` (`ATLAS_WAVE2_LIVE=1`)
- architecture estate: dungeon still has no fetch / `TheBigBrother` / `SpiderFoot` / `node:https` / `node:dns`

## Live public targets (acceptance, isolated)

Observed 2026-09-19 against public sources (not production):

| Target | Result |
|---|---|
| username `octocat` | GitHub profile **confirmed** (HTTP 200, content hash, canonical URL). Other catalog sites negative/error distinguished. 600ms. |
| domain `example.com` | DNS A confirmed; homepage inspect confirmed “Example Domain”; Wayback CDX attempted. |
| domain `wikipedia.org` | DNS A/NS/TXT confirmed; TLS `*.wikipedia.org`; homepage inspect 200; Wayback CDX confirmed. |
| URL `https://example.com/` | Wave 1 inspect **confirmed** HTTP 200, “Example Domain”. |
| IP `127.0.0.1` / `::ffff:127.0.0.1` | **blocked** (`ip.validate`), not scanned. |
| `networkAccess: none` | server-side denial (404 / Permission denied in chat). |

SpiderFoot: **NOT CONFIGURED** in this environment (hypothesis, not a fake PASS).

Do not use private individuals as acceptance targets.
Do not deploy. Do not change public production.
