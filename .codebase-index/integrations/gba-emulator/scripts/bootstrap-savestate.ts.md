# integrations/gba-emulator/scripts/bootstrap-savestate.ts

Deterministically regenerates the pinned
"firered-a-bedroom" savestate from the
operator's ROM: a frozen, frame-verified input
schedule boots from power-on, starts a new
game (player "A", rival "GREEN"), and stops in
the bedroom overworld. Byte-identical output
on every run against the same ROM and core.

Fixture preparation, not a scenario — the
governed scenario derives decisions from
observed state. Writes the savestate to
`CLANKIE_GBA_SAVESTATE_PATH` and prints the
ROM/savestate digests; bytes stay
operator-local, only the SHA-256 is pinned in
the fixture.
