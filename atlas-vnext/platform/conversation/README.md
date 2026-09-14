# Conversation domain

Owns conversation, message, and execution *state*. It does not route (Nexus) and does not talk to providers (execution adapters).

The host injects a capability router and a model executor. Those ports are satisfied by `NexusRouter` and `ExecutionBroker` at composition time.
