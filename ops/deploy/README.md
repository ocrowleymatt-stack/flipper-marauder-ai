# ops/deploy

**Status:** placeholder. Not an npm package.

## Intent

Transactional deployment of the Atlas platform to a runtime (`runtimes/local`, `runtimes/hetzner`,
`runtimes/runpod`): build artefacts, verify, promote, and roll back as a unit. Promotion is gated
by the `deployment.promote` capability scope.

## Will contain

- deployment scripts and runbooks per runtime
- health verification run before promotion
- rollback procedure that restores the previous manifest

## Must NOT contain

- application code or anything imported by workspace packages
- secrets (they come from the environment; see `.env.example`)
