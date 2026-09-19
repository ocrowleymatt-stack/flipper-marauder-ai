# Root cause: successful run, missing answer

Production SHA: `ace41a2587db85b2cd090b2c4b18be8414cd79ba`

## What a person saw

The supplied production screenshot is the defect:

- Run Inspection reported `completed`, `nexus/reason`, `xai / grok-build`, `failure: none`.
- Website Studio occupied the entire centre column.
- The conversation list showed a selected thread whose title collided with a timestamp / email.
- The useful model text was not the primary content.

A later public Playwright trace against `https://atlas.ocrowley.com` showed SSE was healthy (`assistant.delta`, `message.delta`, `execution.completed`). Short echoes could appear in `.messages` and survive reload. The human failure was still real: the answer was easy to miss, easy to drop mid-stream, and often not on screen at all because another surface owned the centre.

## Chain

```
composer submit
  → POST /api/conversations/:id/messages (SSE)
  → Nexus route
  → Execution / provider
  → assistant.delta + message.delta (paired incremental chunks)
  → first assistant `message` envelope often arrives with empty content
  → persistence stores assembled content
  → GET snapshot on refresh has the text
  → Workbench `surface` state decides what the centre renders
```

## Why the answer was not the primary UI

1. **Dungeon surfaces displaced the thread.** `surface` was a mutually exclusive centre pane. Opening Website / OSINT / Music, or remaining on that pane after a run, replaced the conversation. Selecting a conversation did not return `surface` to `conversation`. Run Inspection still hydrated, so the execution looked successful while the answer was off-screen.

2. **`applyStream` dropped live text.** It only appended `message.delta` onto an already-present message id. `assistant.delta` cleared the wait label and did not create a visible turn. An empty later `message` upsert overwrote streamed content. The first send could also land while React `view` was still null.

3. **Layout hierarchy was inverted.** A permanent 320px Run Inspection column dumped execution UUIDs, capability aliases, route reasons, and timestamps in prime space. The thread was a remaining strip. Conversation buttons put title and timestamp on one line, so long titles (emails, OSINT labels) collided with metadata.

This is not cosmetic. A completed execution the user cannot read is not a successful journey.

## Fix in this tranche

- Assemble `assistant.delta` / `message.delta` without doubling the paired chunks; never overwrite streamed text with an empty envelope; create a turn if the envelope never arrives.
- Conversation is the default workspace. Opening or creating a conversation, sending a prompt, or switching project returns to the thread.
- Tools/dungeons, Files, Context, and Caspa are secondary surfaces with **Back to conversation**.
- Run details are an optional drawer. Compact status is Generating… / Completed / Failed / Stopped.
- Sidebar titles ellipsize; timestamps sit on their own line.

Architecture, Authority, Nexus, Execution, cookies, nginx, DNS, Mountain, and production listeners are unchanged.
