# apps/discord-activity/src/client.html

The activity iframe page ("Clankie plays"): a
single self-contained HTML file, dark slate
palette, monospace UI. Layout: a pixelated 3:2
canvas stage over a lower third that keeps
Clankie's self-authored Objective and Thought
separate from the Next (intent) and Observed
(effect) details, with a live/idle status line;
responsive single-column variant under 720px.

The inline module script connects a WebSocket to
`/.proxy/frames` (required by Discord's proxy
CSP), renders base64 PNG frames guarded by
sequence numbers, renders overlays (with a v1
free-form `lines` fallback into the thought slot
so a rolling upgrade never blanks the panel),
distinguishes "session ended" from a dropped
connection, and reconnects every second.
