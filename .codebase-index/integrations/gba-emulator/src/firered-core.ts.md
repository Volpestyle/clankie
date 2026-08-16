# integrations/gba-emulator/src/firered-core.ts

`MgbaFireRedCore` — the real core behind the
seam: the pinned mGBA WASM core running an
operator-supplied FireRed ROM, decoded through
`decodeFireRedState`. `create()` fails closed
unless ROM, savestate, and core-wasm bytes all
match their pinned SHA-256 digests.

Presses run holdFrames held + a 32-frame
settle; `advanceFramesHolding` keeps A/B held
(FireRed's fast-read) but releases the final
frame so a following press lands as a fresh
edge. `gameState()` maps decoded state into
`GbaCoreState`, deriving battle ids/turns from
HP transitions and retaining a terminal
battle_won/lost mode across observations after
the engine clears `gMain.inBattle`.
`battleModeForOutcome` maps gBattleOutcome:
only 1 (won) and 2/9 (lost) are terminal —
ran/caught/fled etc. stay "battle" so their
exit text remains advanceable. Also:
`mapGrid()` from the live map buffer,
`saveState`/`loadState` for checkpoints,
`observeFrames(observer, {pace})` to surface
every intermediate frame with optional async,
deadline-based hardware-rate pacing,
`idleFrames()` for the watched console between
actions, and
`framebufferSnapshot()` for screenshots.
