# OSINT, Investigation, Research

OSINT is a reusable domain/service (`dungeons/osint`), **not Nexus**.

## OSINT concepts (contracts now; product later)

| Concept | Role |
|---|---|
| Target | Person / username / email / domain / ip / org |
| Adapter | One enumerator behind a typed interface |
| Scan job | `platform/jobs` (`queued/running/waiting/paused/completed/failed/cancelled`) |
| Finding | Confidence (`confirmed/likely/possible`), source, timestamp, evidence blob hash, provenance |
| Structured errors | Retryable vs terminal; cancellation; resumability from checkpoint |

commons `who()` and TheBigBrother scanners are **behavioural references**. Do not vendor them into Nexus or into this repo.

## Investigation

Consumes OSINT **through contracts** (findings, evidence hashes, job ids). Owns caseboard, evidential agents, challenge loops. Must not import `dungeons/osint` source or talk to provider SDKs.

## Research

Reuses shared retrieval, provenance, and citation infrastructure (`platform/provenance`, future `platform/search`). Must not duplicate a retrieval stack. Must not embed SpiderFoot in Nexus.

commons `@ocrowley/research` and Caspa research routes are references only.
