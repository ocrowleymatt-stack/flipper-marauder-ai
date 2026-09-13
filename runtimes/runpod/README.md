# @atlas/runtime-runpod

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

RunPod GPU runtime adapter: pod lifecycle and remote worker attachment.

## Must NOT contain

- application logic
- imports of `dungeons/*` or `apps/*`

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
