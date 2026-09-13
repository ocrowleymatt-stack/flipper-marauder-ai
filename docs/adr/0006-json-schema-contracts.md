# ADR 0006 — JSON Schema contracts for a mixed stack

## Status

Accepted (design gate).

## Context

The estate is mixed: TypeScript (Caspa, Mountain Nexus, commons),
Python (Life-os, compute, quantum compile), shell deploy, and device
clients. TypeScript-only types would freeze Python workers out or
invite duplicated shapes.

## Decision

JSON Schema (Draft 2020-12) in `packages/contracts/schemas/` is
canonical. TypeScript types are maintained in lockstep and checked in
CI. OpenAPI references the same schemas. Protobuf is deferred until a
gate needs a binary bus.

## Consequences

- Caspa, Python workers, and the shell can validate without importing
  Nexus code.
- Boundary tests can validate fixtures without compiling adapters.
