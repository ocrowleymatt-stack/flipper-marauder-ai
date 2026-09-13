# platform/execution

Walks a `RouteDecision` from Nexus. Owns streaming, bounded retries, circuit breakers, and adapter I/O.

Production provider clients are not in this phase. `FakeAdapter` / `FailingAdapter` exist for contract tests.

Rule: visible text commits the provider. Never start a second answer.
