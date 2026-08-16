# integrations/gba-emulator/scripts/check-fixture.ts

`fixture:check` — integrity check for the
frozen double fixture at
`scenarios/emulator/verdant-path-trainer-battle/v1`:
the scenario bytes match the `.sha256` sidecar,
the savestate identity digest is self-
consistent, and the binding names the same
scenario id/version/digest. Throws on any
drift.
