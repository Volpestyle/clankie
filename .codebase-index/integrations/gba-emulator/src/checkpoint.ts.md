# integrations/gba-emulator/src/checkpoint.ts

Progress that outlives the process: minted
checkpoints. A save never mutates the current
identity — it mints a sibling: savestate
bytes, a digest receipt, and a companion
scenario so the same fail-closed loader can
boot from it later. Bytes stay operator-local;
only digests appear anywhere.

`writeGbaCheckpoint` captures the core state
into `<root>/<timestamp[-label]>/` (savestate,
canonical-JSON scenario + receipt) recording
position and mind continuity (notes +
objective, so a resumed session restores the
player's head along with the RAM).
`listGbaCheckpoints` returns valid receipts
newest first, skipping foreign files.
`readGbaCheckpoint` refuses path-shaped ids,
receipts that do not name their directory, a
different ROM or core build, and savestate
bytes whose digest drifted.
`defaultGbaCheckpointDir` resolves
`~/.local/state/clankie/gba-checkpoints` (or
`CLANKIE_GBA_CHECKPOINT_DIR`).
