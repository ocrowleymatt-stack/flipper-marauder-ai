# Wave 3 recovery — Website Studio

DO NOT MERGE until Owner Delegate review.
Public production must remain on `68603a465f39ff20804f221b5db6e3faf1cdfb11`.

Accepted development baseline: `1ae4fd031eb51fc89f0c82f14d9fb1c1a08a247c` (Wave 1).
Does not inherit #36 / #37 / #38 / #40.

This tranche restores genuine Website Studio on that spine: a brief becomes a
canonical site with CAS-backed `index.html`, an audit, and a preview the
requesting conversation can see. A chat mock, an empty site, or a content-filter
“Run failed” is not enough.

## Two verdicts (do not conflate)

| Gate | Verdict | Meaning |
|---|---|---|
| WAVE 3 DEFINED-SCOPE GATE | PASS (pending exact-head CI) | Conversation intercept, host-injected generate port, assembler fallback, audit, CAS revision, sandboxed preview, Authority-gated promote. |
| OVERALL ATLAS WEBSITE SAME-OR-BETTER | FAIL | No Playwright QA, no `/dev/<slug>/` public preview, no custom domains, no Visual Studio. |
| WAVE 3 MERGE GATE | pending exact-head CI | GO only if P1s and material P2s on this head are resolved and CI is green. Not a production cutover. |

## Architecture (frozen)

- Thin `dungeons/website` — sites, revisions, audit, conversation return.
- Host-injected `SiteGeneratePort` uses Execution. Dungeon does not import Execution or fetch.
- No `runtime.sendMessage` from generate (that hid output in a second conversation and recursed the workHandler).
- Preview is sandboxed srcDoc. Nexus never mounts a file server.
- Promote remains `deployment.promote` plus stored `repoWrite`.

## Restored now (Wave 3 scope)

1. “Build a website about …” in the requesting Atlas chat creates a canonical site.
2. Model HTML is used only when it passes audit (doctype, lang, title, charset, viewport, no script/handlers).
3. xAI content-filter (and empty/invalid model HTML) falls back to a deterministic assembler. The run completes with a real page, not a failed empty site.
4. `index.html` is stored in CAS with provenance (`site.generate.model` or `site.assemble`).
5. Conversation result-return + follow-ups: show the preview / files / publish.
6. Website questions do not steal Wave 1 research.

## Explicitly not in Wave 3

- Playwright desktop/mobile QA
- Public `/dev/<slug>/` preview
- Custom domains / production publish UX beyond existing Authority
- Visual Studio, ACE-Step, Caspa GoldPipeline, 473-site OSINT

## Live acceptance (isolated, not production)

- Chat: “Build a website about a neighbourhood circus …” → assistant report + preview HTML containing the brief.
- Content-filter from the model → assembler page, not “Run failed”.
- Research questions still run Wave 1 research.

Do not deploy. Do not change public production.
