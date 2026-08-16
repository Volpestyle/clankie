# apps/clankie/src/captain/tools.ts

The captain's authored tool bank
(`captainTools`) plus live browser tools
(`browserTools`). Coding tools are pi built-ins
and not defined here; herdr leadership goes
through bash + the herdr skill.

Authored tools (typebox schemas, results as
JSON text): `generate_image` /`generate_video`
(capture the artifact so it rides the reply;
refusals are sayable), `start_play`/`stop_play`
(via play.ts against the embodiment deps),
`observe_current_activity`,
`observe_room` (reads the LaneLog; from any
non-operator lane the operator's room is
invisible — not listed, not readable),
`get_self_state` (live session, presence,
possession, voice history in one card), and
`remember_episode`.

`browserTools()` resolves the live catalog at
session build (ADR 0082): each advertised tool
becomes `browser_<name>` with the MCP server's
own JSON Schema passed through; the last image
artifact of a call becomes the turn's media.
When the host is unreachable he gets one honest
`browser_unavailable` tool instead of a silently
empty surface.
