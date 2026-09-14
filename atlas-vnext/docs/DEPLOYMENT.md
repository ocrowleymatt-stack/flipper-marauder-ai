# Deployment

Retain operational lessons; do not port historical clutter.

## Keep (behaviour)

- Immutable releases identified by **exact git SHA**.
- Atomic promotion (symlink / pointer flip) so rollback is the previous pointer.
- **Verify** (health, and browser/canary where relevant) **before** declaring production success.
- Production is not live merely because build/CI passed.
- Visible rollback command/path.

Specified AM `deploy/hetzner` atomic symlink (unverified this run) and Caspa `verify-nginx-identity` / deploy smoke are the lesson sources.

## Discard

- nginx `/v12` shims and preview path regexes
- OpenWebUI compatibility probes
- String-needle `check-*-contract.mjs` scripts
- Caspa’s large set of one-off diagnostic GitHub Actions as the control plane
- `archiveB64` / copy-migration patch scripts
- Declaring success from CI green alone

Future `atlas-vnext/ops/deploy` is a later PR. Permission to promote: `deployment.promote`.
