# Atlas vNext

Greenfield rebuild of Atlas.

> Atlas Mountain is a behavioural reference, not an architectural template.

This repository is starting from a clean architectural foundation. Existing Atlas-related repositories are reference sources for proven behaviour, contracts, tests and operational lessons; they are not copied wholesale.

The **design gate** and conversation spine live in [`atlas-vnext/`](atlas-vnext/README.md).

```bash
cd atlas-vnext
npm ci
npm run dev
```

Do not bulk-copy implementation from Atlas Mountain or other legacy repositories. Product implementation proceeds subsystem-by-subsystem after this gate.

See [`atlas-vnext/docs/ARCHITECTURE-REVIEW.md`](atlas-vnext/docs/ARCHITECTURE-REVIEW.md).
