# apps/clankie/src/captain/lane-log.ts

`LaneLog`: one JSONL file per room
(`<lane>~<encoded targetId>.jsonl`) recording
what he heard and said there. This is what makes
him one person across rooms — the
`observe_room` tool and the TUI lanes view both
read it.

`append(lane, targetId, entry)` writes {at,
kind: heard|said, text}; `read()` returns the
last N entries (default 40); `list()`
enumerates every lane file with a bounded tail
per room. Entries are bounded on read, never
rewritten; unparseable lines are skipped.
