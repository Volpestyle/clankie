# apps/tui/src/session/trace-cursor.ts

`TraceCursorStore` — the mode-0600 checkpoint for
`clankie trace` at
`.../clankie/captain-trace-session.json`. Writes only
identity fields (generation, sessionId, streamIndex,
lane, active) — never event payloads — via a
serialized write queue with atomic temp-file rename
and a 0700 parent. Reads fail loudly on any invalid
schema (only ENOENT is "no cursor").
`emptyTraceCursor` seeds a fresh one.
