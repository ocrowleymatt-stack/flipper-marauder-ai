# OSINT, Investigation, Research

OSINT is a reusable domain/service (`dungeons/osint`), **not Nexus**.

## OSINT concepts

| Concept | Role |
|---|---|
| Target | Person / username / email / domain / ip / url / org |
| Adapter | Host-injected `PublicLookupPort` (Wave 1 inspect + bounded probes) |
| Scan job | `platform/jobs` (`queued/running/waiting/paused/completed/failed/cancelled`) |
| Finding | Observation with status, source, URL, hash, provenance |
| Correlation | Separate record; not silently promoted to fact |
| Structured errors | Negative ≠ blocked ≠ rate-limited ≠ error; cancellation; checkpoints |

commons `who()` and historical scanner suites are **behavioural references**. Do not vendor them into Nexus or into this repo.

Wave 2 restores bounded public-source acquisition and conversation result-return.
The 473-site historical table, full specialist-engine scans, and darkweb remain later tranches (parity FAIL until restored).

## Investigation

Consumes OSINT **through contracts** (findings, evidence hashes, job ids). Owns caseboard, evidential agents, challenge loops. Must not import `dungeons/osint` source or talk to provider SDKs.

## Research

Reuses shared retrieval, provenance, and citation infrastructure (`platform/search`, `platform/provenance`). Must not duplicate a retrieval stack. Must not embed a specialist OSINT engine in Nexus.
