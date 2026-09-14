# @atlas-vnext/projects

Platform primitive: durable, versioned projects.

Projects **are** tenant-scoped workspaces. A writing manuscript and an OSINT case are both projects with different `dungeon` labels and manifests. `ProjectService` is first-class CRUD (create/get/list/update/archive/restore/logical delete) with optimistic concurrency. There is no raw-id bypass: every call carries a tenant actor.

Conversations, files, jobs, and artefacts may belong to a project; conversations are not the only child.
