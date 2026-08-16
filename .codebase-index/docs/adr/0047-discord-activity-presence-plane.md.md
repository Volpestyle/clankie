# docs/adr/0047-discord-activity-presence-plane.md

The watch surface: Discord's Embedded App SDK
(activities) carries Clankie's rendered GBA frames
into a voice channel on official bot transport —
the sanctioned answer to "bots cannot Go Live".
`apps/discord-activity` owns the iframe client
and frame server.

Read for the frame-transport seam: two listeners
(public viewer via the discordsays proxy; producer
loopback-only, never tunnelled), the runner dials
out with a brokered bearer, lossy-by-design in
both directions, ROM/core/savestate never cross
the wire. Activity state is a session facet, not
a phase-ladder rung; `activity_*` actions are
publish-external and viewer input is ambient
authority.
