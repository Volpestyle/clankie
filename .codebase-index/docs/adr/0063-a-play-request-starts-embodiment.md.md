# docs/adr/0063-a-play-request-starts-embodiment.md

A play request becomes a first-class embodiment
intent: the captain exposes `start_play` /
`stop_play`, the service records and admits the
request, and the play host alone boots and owns
the emulator session.

Read for the ownership split: tools stamp
`requestedBy` from authenticated context, bounded
startup waits return started/refused/pending, and
the cross-process body lock stays the final mutex
across asked play, MCP possession, and CLIs. A
missing caller budget means open-ended play under
the owner's explicit default, with stop and
checkpoint controls still active.
