# packages/interactive-environment/test/emulator.test.ts

GBA emulator contract suite. Covers: bounded
button/frame-advance/wait actions with impossible
values (unknown buttons, zero/huge holdFrames,
macro_replay, stray fields) rejected;
normalization through the shared v2 union with no
Minecraft/PokeMMO field leakage and binding
mismatches rejected; emulator bounds inside a v2
lease; strict start-action commands refusing
unknown fields (e.g. packetInjection);
observation bounds — valid overworld and
frame_reference (artifact:// only, network URIs
refused), HP-exceeds-max party rejected, battle
requires `untrusted: true`, unknown kinds like
ram_dump rejected; lane-scoped tool exposure
(gameplay tools only in the active gameplay lane,
supervision lanes steer/pause/resume); and the
capability boundary being structurally unable to
represent network or remote-tamper capabilities.
