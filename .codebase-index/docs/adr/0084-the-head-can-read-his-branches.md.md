# docs/adr/0084-the-head-can-read-his-branches.md

Clankie himself can read his other rooms — from
the operator seat only. `CaptainLaneRegistry`
keeps a bounded per-room session history (64),
and the `observe_room` tool replays a room's
sessions: what he heard, what he said, tools with
arguments and results — never his reasoning.

Read for the asymmetry, which is the security
boundary: the tool is offered only in the
authenticated operator lane, gated by trusted
channel context (never a tool argument); every
ambient lane keeps ADR 0054's transcript fence,
or anyone who can type at him could pull the
operator transcript. Also fixes the rotation bug
that pinned Discord text rooms to their first
session. Reads are time-bounded (4s/session,
10s/look) and identity-only — no tokens, no
writes.
