# integrations/gba-emulator/test/free-play-competence.test.ts

Tests the competence benchmark end to end on
the deterministic double: two runs of the
pinned seeds are identical and pass with
objective milestones; a repeat-only mind fails
`notRepeatOnly`; receipt building and
`evaluateFreePlayCompetenceReceipt` accept
valid evidence and reject tampered reports,
symlinks, and drifted identities.
