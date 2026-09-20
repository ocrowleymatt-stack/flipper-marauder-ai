# Wave 5 — Website Studio recovery

Defined-scope recovery of conversation-first Website Studio on accepted Wave 4 main `11673ca8488616521810e1736ea2485a1d66a3f7`.

PR #41 is forensic evidence only. It was not merged, rebased, or cherry-picked.

## Restored

- Ask Atlas “build a website…” intercepts after OSINT and writing, before research.
- Host `SiteGeneratePort` (`NodeSiteGenerate`) — Nexus WHERE, Execution HOW. Dungeon does not `sendMessage`.
- Same requesting conversation receives a Website result card.
- Durable site revisions in CAS; Library file `sites/<id>/index.html` with Generated origin.
- Sandboxed preview from the committed artefact (source of truth).
- Follow-up edits and regenerate target the conversation-bound site.
- Server-side Authority, tenant isolation, privacy overlay, autonomyCeiling.
- Direct `POST /api/sites/:id/generate` admits a ResourceGuard run via `admitRun` / `tenantId`. Conversation intercept omits that extra slot — `sendMessage` already holds the permit.

Browser evidence: `docs/release/workbench-ux/12-wave5-desktop.png`, `13-wave5-mobile.png`.

## Still FAIL vs atlas-mountain Website Studio

- Public `/dev/<slug>/` preview URL
- Playwright visual QA / repair loop
- Multi-file working tree
- Custom domains / production cutover
- Visual Studio overlay

## Do not copy

- #41 project-latest canonical site (wrong regenerate identity)
- #41 assembler fallback on abort
- Frontend privacy as enforcement
- Competing Website shell
- Nexus-mounted preview servers

DO NOT DEPLOY. Public production remains `68603a465f39ff20804f221b5db6e3faf1cdfb11`.
