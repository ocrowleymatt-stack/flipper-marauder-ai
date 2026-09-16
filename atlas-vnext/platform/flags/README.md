# @atlas-vnext/flags

Platform primitive: feature flags and operational kill switches.

Experiments and kill switches belong here, not as dungeon-local booleans. Persistence of flag history is deferred; production reads shared process environment.

Kill switches (`tools`, `generation`, `dungeon.writing`, `ATLAS_KILL_PROVIDERS`) refuse work. They are **not** Authority and never grant capabilities.
