# packages/interactive-environment/src/emulator.ts

The GBA emulator profile: how Clankie plays
Pokemon on a locally-run core.

- `GbaEmulatorActionSchema` — button_press (with
  bounded `repeat` so a corridor costs one
  decision), frame_advance, wait, and three
  catalogued state-checked actions that exist
  because termination must be verified against
  live state between presses: `walk_to` (routes
  around collision), `advance_dialog` (stops
  exactly at close/choice/battle, returns the
  text), `enter_text` (naming screen, idempotent
  by prefix), `select_menu_entry` (walks the
  cursor to a named entry). Wrapped with
  input/frame/timeout limits.
- `GbaEmulatorSessionSpecSchema` + strict
  command set (`GbaEmulatorCommandSchema`, own
  schemaVersion 1) with binding refinements.
- `GbaEmulatorObservationSchema` — overworld
  (position, facing, per-direction tile collision,
  ASCII minimap with warp `D` markers, exits/
  connections, ramStateSha256), menu, party,
  inventory (Gen-3 pockets), battle, dialog,
  scene (mode + inputReady +
  waitingForDialogAdvance), frame_reference
  (`artifact://` URI + digests, never bytes),
  danger, action. `GbaEmulatorObservationKind
Schema` mirrors the union with a compile-time
  drift guard.
- Tool exposure mirrors the other profiles
  (`resolveGbaEmulatorToolExposure` + forgery-
  rejecting schema).
- `GBA_EMULATOR_CAPABILITY_BOUNDARY` — local-only:
  observe/input/frame_advance/wait; network and
  remote-tamper capability arrays are typed
  `z.never()`, structurally empty.
