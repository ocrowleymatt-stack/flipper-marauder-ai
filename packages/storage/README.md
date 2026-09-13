# Storage boundary

Design-gate placeholder for the content-addressed blob store, durable relational
core, migrations, Vault metadata, snapshots, backup, and restore. Domain
packages consume storage through broker operations and contract references;
they do not import this package directly.

No persistence implementation is included at this gate. See
`docs/STORAGE-MODEL.md`.
