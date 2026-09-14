# Website Studio model

Product implementation is deferred. This is the frozen concern split.

A site is **one** canonical `platform/projects` record. Conversation history is not the site.

## Separate concerns

| Concern | What it is | What it is not |
|---|---|---|
| Canonical working tree | Current source, pointed at by `root_manifest_hash` | A chat transcript |
| Source revision history | Lightweight manifests (hash lists) | A copied `node_modules` per revision |
| Build cache | Disposable, GC-first under disk pressure | A revision |
| Preview deployment | Ephemeral URL, untrusted, no custom domain | Production |
| Production deployment | Protected, promoted atomically, exact SHA | “CI passed” |
| Domains | Bound only to protected production | Preview |
| Artefacts | CAS blobs with provenance | Inline base64 |

## Rules

1. One canonical project per site.
2. Revisions are manifests, not duplicated dependency trees.
3. Bounded retention + GC; prune disposable caches first.
4. Explicit preview vs production.
5. Production and custom-domain sites are protected (permission `deployment.promote`).
6. Atomic revision writes; restore = point `root_manifest_hash` at a previous manifest after integrity check.
7. Disk-pressure handling: refuse new preview caches before evicting production artefacts.
8. Nexus never mounts preview file servers.

Nexus-mounted `dev-preview` / HTTP file serving (specified AM behaviour) is **DISCARD**.
