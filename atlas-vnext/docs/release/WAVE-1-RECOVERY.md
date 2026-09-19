# Wave 1 recovery — Atlas intelligence spine

DO NOT MERGE until Owner Delegate review. Public production must remain on
`68603a465f39ff20804f221b5db6e3faf1cdfb11`.

This tranche restores the smallest set of predecessor capabilities that make
Atlas feel like Atlas, on the stronger vNext architecture:

- Nexus = WHERE, Execution = HOW
- no failover after visible output
- Behaviour ≠ Authority
- server-derived tenant, server-side Authority
- thin dungeons; shared Projects/Files/CAS/Context/provenance
- host-injected search and source inspection (dungeons do not fetch)

## Restored

1. Conversational continuity — bounded durable history into every model call.
2. Result-return — research briefs/syntheses bind `conversationId`; claimed turns
   stream into the requesting Atlas chat.
3. Shared search — Brave + SearXNG when configured, Wikipedia always in live,
   two fixture engines in mock; canonical URLs, RRF, fail-soft.
4. Bounded HTTP inspect — SSRF, credentials, redirects, size, content-type.
5. Deep research loop — plan, search, inspect, extract, coverage, second wave,
   contradiction check, deterministic cited synthesis.
6. Atlas-first chrome — New Chat / Chats / Projects / Library / Dungeons.
   Run details stay an advanced inspector.

## Not in Wave 1

Full OSINT estate, ACE-Step, GoldPipeline, Caspa psychology, Website Studio
product work, Investigation caseboard.

## Gates

See `apps/host/tests/wave1-recovery.test.ts`, `dungeons/research/tests/research.test.ts`,
`apps/host/tests/search-inspect.test.ts`, `platform/conversation/tests/history.test.ts`.
