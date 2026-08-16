# docs/adr/0096-a-diagram-is-something-he-draws.md

`draw_er_diagram` and `draw_sequence_diagram`
accept structured content on every lane while a
governed host owns all JavaScript sent to tldraw.
The result is a hash-bound `tldraw/` artifact that
rides the turn's media reply.

The operator selects the named design system;
Clankie selects only content. Requests are double-
encoded into host snippets, the desktop app is
reached lazily, and an unavailable canvas returns
`canvas_unavailable` rather than affecting boot or
the rest of the turn.
