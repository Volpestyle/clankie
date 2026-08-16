# apps/clankie/test/play-round-trip.test.ts

The asked-play round trip run for real on the
deterministic GBA core double, with a
button-masher mind (the loop is under test, not
the play) and temp state dirs: claims, runs the
budgeted turns, and reports the receipt;
mints a checkpoint on stop and resumes from it
on the next ask; neither lists nor resumes
another game's checkpoints sharing the root
(ROM/core sha gates); banks autosave
checkpoints on the configured cadence;
restarts to the boot savestate on his own ask,
banking the present first; and refuses
`body_held` when another process holds the
body lock.
