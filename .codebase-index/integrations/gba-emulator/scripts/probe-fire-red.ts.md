# integrations/gba-emulator/scripts/probe-fire-red.ts

`probe:firered` — operator-local
fixture-development instrumentation: applies a
bounded caller-supplied input list
(`CLANKIE_GBA_PROBE_INPUTS`, max 256 presses)
to the real core from a savestate, decoding
`decodeFireRedState` after every press.

Writes decoded observations + digests
(`probe.json`), a screenshot (`frame.png`),
and optionally the resulting savestate — all
outside the repository. ROM, savestate, and
RAM bytes never enter the JSON report. This is
the tool that empirically verified the RAM
offsets in firered-ram-map/firered-state.
