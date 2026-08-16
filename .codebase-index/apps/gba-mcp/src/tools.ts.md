# apps/gba-mcp/src/tools.ts

The tool handlers behind the MCP surface,
plus their argument schemas. Deliberately a
second consumer of the existing emulator
catalogue — nothing here invents a
capability; every action dispatches through
the `GbaDriverIo` runtime seam in
`GbaToolContext`.

Key exports:

- `ActArgumentsSchema` — flat (providers
  reject `oneOf`) arguments for
  button_press, walk_to, advance_dialog,
  enter_text, select_menu_entry,
  frame_advance, plus an optional
  `monologue` line for watchers. The
  catalogued `wait` is deliberately
  omitted: a clockless core never
  completes one. `repeat` is capped at
  `FREE_PLAY_ACTION_LIMITS.maxInputs`.
- `toAction` — maps flat args to the raw
  catalogued action (default hold 16
  frames: a short tap only turns).
- `observeTool` — reads every applicable
  view (danger/scene/overworld/battle/
  dialog/menu) and appends the frame PNG
  as an image part.
- `actTool` — lease check, schema parse
  (fail closed with the reason), publish
  monologue only after the lease check,
  dispatch, and surface non-completed
  results as errors.
- `pauseTool` (lease-free) / `resumeTool`
  (lease-gated like acting).
- `saveStateTool` / `loadStateTool` —
  checkpoint hooks; load with no id lists
  checkpoints, a successful restore
  returns the fresh observation inline.
- `GbaToolContext`, `GbaCheckpointSummary`
  (digests stay out of summaries).

All errors become `isError` results with
the message truncated to 500 chars.
