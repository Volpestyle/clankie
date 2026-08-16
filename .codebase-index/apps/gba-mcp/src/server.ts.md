# apps/gba-mcp/src/server.ts

`createGbaMcpServer(context, options)` —
builds the `McpServer` ("clankie-gba") and
registers every tool with its zod input
schema and driver-facing description. Tool
names mirror `GbaEmulatorToolNameSchema` so
an external caller and Clankie's own loop
share one capability vocabulary.

Registered tools:

- `clankie_listen` — recent voice
  transcript lines; lease-gated, lazy
  subscription via `PossessorHearing`.
- `clankie_say` — report an event so
  Clankie talks about it; lease-gated,
  routed through the speech port.
- `gba_emulator_possess` / `_release` —
  only when a `PossessionLease` is passed;
  grant returns the token to act with.
- `gba_emulator_observe` — decoded views
  plus the rendered frame.
- `gba_emulator_start_action` — one
  catalogued action, with possessionToken.
- `gba_emulator_save_state` /
  `_load_state` — checkpoint mint/restore,
  lease-gated.
- `gba_emulator_pause` (lease-free) /
  `_resume` (lease-gated).

Speech and hearing default to the denied
ports from `speech.ts`; release clears the
hearing window so nothing heard outlives
the possession.
