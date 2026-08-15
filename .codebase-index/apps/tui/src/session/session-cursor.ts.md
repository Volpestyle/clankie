# apps/tui/src/session/session-cursor.ts

`CaptainSessionCursorStore` — the headless captain
session checkpoint (v2 cursors carry a 64-hex build
generation; v1 legacy cursors still parse). Strict
structural validation encodes the invariants (active
requires a sessionId; no continuation or nonzero
index without one); an unreadable or invalid file
throws rather than risking resuming the wrong
session. Same atomic 0600/0700 write-queue pattern
as the trace store. The trace command adopts this
store's session identity when generations match.
