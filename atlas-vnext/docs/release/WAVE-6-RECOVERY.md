# Wave 6 — score-first Music recovery

Defined-scope recovery of conversation-first Music on accepted Wave 5 main `95d85cb8ae7d99e3a819d2e84cb04474c9c2d7cb`.

ACE-Step is absent and is not part of this tranche.

## Restored

- Ask Atlas music asks intercept after OSINT, writing, and Website, before research.
- Writing no longer steals “Write a song about rain”.
- Host `MusicScorePort` (`NodeMusicScore`) — Nexus WHERE, Execution HOW. Dungeon does not `sendMessage` or create a second conversation.
- Canonical identity is a validated structured score. MIDI and stereo WAV are derived.
- Same requesting conversation receives a Music result card with Play/Pause, duration, revision, Open, and downloads.
- Durable composition in CAS; Library files `compositions/<id>/score.json`, `composition.mid`, `audition.wav` with Generated origin.
- Authenticated tenant-scoped byte stream (`/api/compositions/:id/audition`, `/api/files/:id/content`) with Range, nosniff, private no-store.
- Follow-up and regenerate target the conversation-bound composition, not the latest project composition.
- Server-side Authority, tenant isolation, privacy overlay, autonomyCeiling.
- Abort never commits a success card or publishes WAV.

Browser evidence: `docs/release/workbench-ux/14-wave6-desktop.png`, `15-wave6-mobile.png`.

## Still FAIL vs atlas-mountain Music

- ACE-Step / neural audio
- Style/vocals as a GPU renderer
- Job progress UI for a leased music runtime
- Public artefact stream without a session

## Do not copy

- The previous vNext `MusicService.compose()` second-conversation text packet
- AM god-service / `content_base64` SQL blobs
- MusicDungeon overlay as a second product shell
- Treating the LLM RunPod as ACE-Step
- Assembler-style fake WAV after abort or invalid score

DO NOT DEPLOY. Public production remains `68603a465f39ff20804f221b5db6e3faf1cdfb11`.
