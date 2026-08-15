# integrations/gba-emulator/test/firered-state.test.ts

Tests `decodeFireRedState` and
`decodeFireRedText` against synthetic
EWRAM/IWRAM images it builds byte by byte
(encrypted party records with real substruct
permutation and checksums, battle structs,
menus, dialog, text control codes). Verifies
both correct decoding and the fail-closed
paths for out-of-domain values.
