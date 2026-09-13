# @atlas/platform-storage

**Status:** placeholder. This package exports only `PACKAGE_NAME`; nothing here works yet.

## Single responsibility

Content-addressed storage: blobs keyed by sha256 digest and `Manifest` trees, with local and remote backends.

## Must NOT contain

- interpretation of content
- project or revision semantics
- model calls

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the dependency-boundary rules enforced by `npm run boundaries`.
