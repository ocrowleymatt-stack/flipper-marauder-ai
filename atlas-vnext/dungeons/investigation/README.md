# Investigation dungeon

Domain: caseboards, evidential substrate, multi-role challenge loops.

Durable evidential objects live as typed `dungeon_records` that point at Projects / Files / CAS / provenance. FACT, SOURCE ASSERTION, INFERENCE, HYPOTHESIS, and CONTRADICTION are disjoint classes; an inference cannot be rewritten into a fact.

A2 adds deterministic analysis on top of that ledger: communication-thread reconstruction, chronology grouping, alias candidates (reversible, never auto-resolved), claim/evidence matrices, corroboration/contradiction/gap reports, and hypothesis tests. Thin timeline / network / matrix views consume those typed results. Retrieval and compiled context go through the generic `ContextService` / `ContextCompiler` contracts — this dungeon does not own a private retrieval stack.

Must not import other dungeons or provider adapters.
