# docs/adr/0014-live-eve-captain-session-boundary.md

The TUI is a loopback-only client of one shared
captain-session singleton; the session runtime
owns durable conversation history, compaction,
and continuation tokens, and the TUI persists
only a mode-0600 cursor file.

Read for the session-boundary invariants:
continuation tokens are capability-like and never
enter logs or transcripts; provider credentials
resolve inside the captain service, never the UI;
stream abort is not turn cancellation. Written in
the eve/mission era — the boundary survives, the
mission vocabulary does not.
