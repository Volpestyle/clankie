# apps/clankie/src/captain/port.ts

`CaptainPort`: the seam between the HTTP app and
the pi captain. The app parses and
authenticates; the captain owns sessions, tools,
and persona. Methods: `submitDiscordTurn` (one
message = one turn), `serveOperatorConversation`
(TUI/relay wire contract), `observeLanes` (lane
transcript snapshots), `voiceLaneInstructions`
(realtime briefing fragment), `close`.

Also defines `LaneObservation`/`Entry` and
`createStubCaptain()`, the test stand-in that
lets every route suite run without a model.
