# @atlas-vnext/tools

Tool platform: typed registry, transactional lifecycle, server-side approval, durable idempotency, cancellation, and provenance.

Nexus does **not** execute tools. Execution assembles streamed fragments and only emits structurally complete calls. This package validates, authorises, optionally awaits approval, and executes **once**.

Plugins cannot bypass Authority. Model-supplied arguments cannot fabricate permissions. Incomplete/fragmented calls never execute.

Progress uses the existing jobs/events stack. Tool work does **not** own RunPod lifecycle.

See [docs/TOOLS-AUTH-AUTHORITY.md](../../docs/TOOLS-AUTH-AUTHORITY.md).
