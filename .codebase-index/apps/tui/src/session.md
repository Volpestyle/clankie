# apps/tui/src/session

Console-to-service conversation and observation seams plus optional Herdr reporting. Durable chat state belongs to the service and per-surface selection/tail stores; `/trace` observes bounded room lane logs rather than Pi stream events.

- `herdr-report.ts` — optional pane metadata/status reporting.
- `lane-observation.ts` — list, select, attach, and detach room lane tails.
- `operator-conversation-renderer.ts` — typed conversation event to transcript blocks.
- `operator-conversations.ts` — authenticated registry client, selection, cursors, and prompt session.
