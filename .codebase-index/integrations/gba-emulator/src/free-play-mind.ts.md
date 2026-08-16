# integrations/gba-emulator/src/free-play-mind.ts

The model-backed decision makers:
`createModelFreePlayMind` (the player) and
`createModelVoice` (the talker), both built on
the `ai` SDK's `streamObject`.

The wire schema is deliberately flat — the
real action union compiles to `oneOf`, which
OpenAI structured output rejects — so the
model fills a flat shape and `toDecision`
reassembles the catalogued action (defaulting
`holdFrames` to 16 when omitted; the driver
still re-validates). `FREE_PLAY_SYSTEM_PROMPT`
is identity-free on purpose (the owner's
character layer leads the prompt) and teaches
the surface: minimap coordinates, walk_to,
advance_dialog, select_menu_entry, enter_text,
checkpoints, and honest intent. `renderView`
serializes observations plus notes, refusals,
stall count, and history; the frame rides
along as a PNG file part. Calls are streamed
(the Codex OAuth path requires it), the system
prompt carries an Anthropic prompt-cache
breakpoint, and `settleWithinDeadline`
enforces the request timeout even when the SDK
routes a failure into a closed stream whose
object never settles — the bug that once hung
an asked-play session for three hours.
