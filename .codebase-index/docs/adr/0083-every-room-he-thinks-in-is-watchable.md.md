# docs/adr/0083-every-room-he-thinks-in-is-watchable.md

The supervising console can inspect every room he
answers in: `GET /captain/v1/lanes` publishes the
authoritative session→lane map (identity only —
no messages, tools, or continuation tokens,
structurally), and the TUI's `/trace` tails any
room's public session stream read-only.

Read for the boundaries: observing can never
become steering (the listing channel serves
routes only), watched payloads are sanitized and
never labeled as the operator's, and the tail is
rotation-aware because Discord text lanes mint a
fresh session per turn. The listing is a live
map, not history; durable scrollback stays the
conversation projection's job.
