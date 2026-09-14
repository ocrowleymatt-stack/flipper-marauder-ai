# @atlas-vnext/events

Platform primitive: event bus and live progress.

Job progress and streaming inference are pushed over SSE or WebSockets. Polling loops are forbidden for active UI views.

This package is the event contract (publish, subscribe, history, replay). Durable PostgreSQL streams live in `platform/persistence`. Live SSE may fan out in-process after commit.
