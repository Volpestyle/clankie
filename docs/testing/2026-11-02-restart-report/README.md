# Surviving Codex report admission (#288)

Read-only diagnosis on the Mac, 2026-11-02:

- Original desktop hire record remains present, with the original TUI PID and native session.
- The installed `desktopCodexAdmission` accepts the surviving worker's actual bridge ancestry. The real kernel listener check succeeds, the original TUI endpoint is observed, and the hired session is loaded.
- The service log records `not_member` for that bridge at 03:32:28 UTC, before #289. There are no subsequent requests from that bridge after the restart onto #289.
- `seat-channel.mjs` permanently latches `membershipStopped` after a membership refusal. `inboundRequest` then fabricates a local 403 without contacting the service. This produces the reported error even after service admission has recovered.

Fix and real-Codex verification are in progress. Existing running bridges retain loaded JavaScript; deploying a source change alone cannot change their already-latched state.
