# Website Studio model

Wave 5 restores the first conversation-first product slice. The frozen concern split still holds.

A site is **one** canonical `platform/projects` / `site_records` identity. Conversation history is not the site.

## Separate concerns

| Concern | What it is | What it is not |
|---|---|---|
| Canonical working tree | Current source, pointed at by `root_manifest_hash` | A chat transcript |
| Source revision history | Lightweight manifests (hash lists) | A copied `node_modules` per revision |
| Build cache | Disposable, GC-first under disk pressure | A revision |
| Preview deployment | Ephemeral, untrusted, sandboxed `srcDoc` | Production |
| Production deployment | Protected, promoted atomically, exact SHA | “CI passed” |
| Domains | Bound only to protected production | Preview |
| Artefacts | CAS blobs with provenance | Inline base64 |

## Rules

1. One canonical site record; revisions are manifests, not duplicated trees.
2. Bounded retention + GC; prune disposable caches first.
3. Explicit preview vs production.
4. Production and custom-domain sites are protected (permission `deployment.promote`).
5. Atomic revision writes; restore = point current revision at a previous manifest after integrity check.
6. Nexus never mounts preview file servers.
7. Generation is a host-injected `SiteGeneratePort`. The dungeon does not `sendMessage` and does not own a second conversation.
8. The requesting Atlas conversation owns the visible Website result card.
9. Follow-up and regenerate target the conversation-bound site, not “latest in project”.
10. Cancellation before commit does not assemble a fake success. After commit, later derived failure does not erase the site.

Nexus-mounted `dev-preview` / HTTP file serving (specified AM behaviour) is **DISCARD**.
Public `/dev/<slug>/` URLs, Playwright visual QA, Visual Studio, and custom domains remain **FAIL** vs atlas-mountain.
