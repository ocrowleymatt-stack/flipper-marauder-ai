# Atlas vNext Capability Census

Ground-up audit of the ocrowleymatt-stack clones available to this design gate. Atlas Mountain is a behavioural reference, not an architectural template.

## 1. Failure modes in the inherited estate

1. **Nexus bloat.** AM `services/nexus` hosts writing, investigation, research, website studio, music, quantum, attachments, auth, jobs, and provider HTTP.
2. **Routing mixed with transport.** Capability ranking lives next to fetch, SSE parsers, retries, and GPU leases.
3. **Storage fragmentation.** SQLite base64 attachments, ad-hoc folders, no CAS.
4. **Ad-hoc jobs.** `setInterval` runners per domain; Caspa and commons each have another queue.
5. **Scattered permissions.** UI, Fastify hooks, and Life-os Themis use different vocabularies.

## 2. Matrix

| Capability | Where it lives | Duplicates | Strongest behaviour | Disposition |
|---|---|---|---|---|
| Provider routing | AM `providers/capability-router.ts` | Caspa unified/llm/cloud routers; commons `ai-client` | AM aliases + ranking | **Redesign** → Nexus |
| Retry / failover / streaming | AM `failover-provider.ts`, `streaming/` | Caspa `routerFailover`; commons SSE | AM tool-buffer + no double stream | **Redesign** → execution |
| Health / discovery | AM `provider-health.ts`, `ollama-discovery.ts` | Caspa `publicHealth`, `freeModelPool` | AM configured vs healthy | Snapshot in Nexus; probes in execution/runtime |
| OpenAI / Anthropic / Gemini / Venice / Ollama adapters | AM `providers/*` | Caspa `server.ts`; Shakespeare `ai.ts` | AM tool-call SSE | Later, in execution adapters only |
| RunPod / GPU | AM `compute/`, `runpod-*.mjs` | none | AM GPU profile | Later `runtimes/runpod` |
| Hetzner deploy | AM `deploy/hetzner/` | Caspa deploy Action | AM atomic symlink | Later ops; drop `/v12` and needle scripts |
| Writing | AM `writing/`; Caspa; Shakespeare; commons literary-* | many | Caspa craft + AM claim ledger | Later `dungeons/writing` |
| Website studio | AM `site-lifecycle.ts`, `dev-preview.ts` | none | AM quota/prune | Later `dungeons/website` — not Nexus HTTP file serving |
| OSINT | commons `osint`; TheBigBrother; AM `bigbrother.ts`; Caspa osint routes | many | commons `who()` + BigBrother scanners | Later `dungeons/osint` |
| Investigation | AM `investigation-run-executor.ts` | none of equal depth | AM multi-role challenge loop | Later `dungeons/investigation` |
| Research | AM `research/runner.ts`, Arcanum, SpiderFoot | Caspa research routes; commons `research` | AM federated runner | Later `dungeons/research` |
| Storage | AM `attachments.ts` | Caspa project sync; commons persistence | AM MIME/SHA ideas | **Redesign** CAS |
| Jobs | AM commission/research runners | Caspa jobQueue; commons CaspaJobService; Life-os orchestrator | commons staged jobs + AM recovery | **Redesign** `platform/jobs` |
| Auth | AM native-auth sidecar | Caspa Firebase/Authentik | AM PKCE + scrypt | Later `platform/auth` |
| Permissions | AM `permissions/engine.ts` | Life-os Themis; commons policy | AM scopes + Themis risk | `platform/permissions` |
| Local / device | AM companion/relay; historical Flipper repo | none | AM companion sandboxing | Later `runtimes/local` |
| Browser tools | AM Playwright MCP | Caspa puppeteer | AM MCP | Later execution/browser |
| Observability | AM trace-store / performance | Life-os decision_logger | AM EWMA latency | Later `platform/observability` |
| UI shell | AM desktop App.tsx | Caspa, Shakespeare | AM visual viewport contract | Later `apps/web` |
| Projects | AM `projects.ts` | Caspa hybridCoreRepository | AM project context scoring | `platform/projects` |

## 3. Outside Atlas Mountain (must not be missed)

1. **OSINT** is primarily commons + TheBigBrother, not AM.
2. **Writing craft** is primarily Caspa, not AM.
3. **Shared jobs/SSE/ai-client/policy/audit** live in ocrowley-commons.
4. **Approval/risk factory** lives in Life-os Daedalus.
5. **Flipper/local radio** historically lived in this repo; current `main` has no device sources.
6. **craigs-navigator** is not an Atlas capability.

## 4. Tests worth preserving later (not copied now)

- AM: `capability-routing`, `failover-provider`, `writing-commission`, `claim-ledger`, `investigation-assurance`, `attachments` (as negative examples for blobs-in-SQL).
- Caspa: `unifiedRouter`, `jobQueueService`, literary pipeline tests.
- commons: `osint` who/dossier tests; jobs SSE tests.
- Life-os: Themis no-go tests.

Preserve as *acceptance behaviour*, reimplemented against vNext packages.
