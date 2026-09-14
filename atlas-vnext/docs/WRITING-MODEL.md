# Writing model

Product implementation is deferred. Caspa remains a behavioural reference, not a tree to copy.

## One durable Book Project

A writing work is **one** `platform/projects` record (dungeon `writing`) whose manifest covers:

manuscript · chapters · structure · characters · research notes · continuity · voice/style · editorial · publishing

Conversation is ephemeral. The Book Project is authoritative.

## Rules

1. **No multiple parallel writing databases.** Caspa PostgreSQL revisions, Shakespeare local state, commons literary stores, and specified AM writing folders collapse into `platform/projects` + CAS + one jobs engine.
2. Do not port Caspa product UI, GoldPipeline, or Caspa routers in this gate.
3. Keep later, via contracts: claim ledger, stylometry, craft rules, immutable version conflict (`VERSION_CONFLICT` in Caspa `hybridCoreRepository`).
4. Long-running commissions are `platform/jobs`, not dungeon `setInterval` runners.
5. Writing must not import OSINT or investigation dungeons; shared retrieval goes through research/OSINT **contracts**.
