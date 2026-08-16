# apps/gba-mcp/test/tools.test.ts

Tool handlers against a mocked
`GbaDriverIo`: observe returns decoded
state plus the frame (and omits the image
when nothing rendered), actions dispatch
through the runtime seam, uncatalogued
buttons and the removed `wait` action fail
closed, emulator refusals surface as
errors, and the lease gate blocks acting,
resuming, checkpointing, and monologue
publication for non-holders.

Also covers checkpoint save/list/load flows
(including the double's
`checkpoints_unavailable`), the repeat
budget matching
`FREE_PLAY_ACTION_LIMITS.maxInputs`
exactly, the 16-frame default hold, and
`advance_dialog` carrying no arguments.
Several tests are regression tripwires —
the `wait` wedge and the timid-repeat
schema mismatch.
