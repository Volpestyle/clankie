# integrations/gba-emulator/src/adapter.ts

The governed emulator adapter — the biggest
file in the package. `GbaEmulatorAdapter`
implements `EnvironmentAdapter`; it owns no
action loop: `EnvironmentRuntime` dispatches
into `startAction`, and this file validates
the strict contract, enforces lease bounds and
capabilities, drives the `GbaCoreSeam`, and
records hash-chained evidence.

`GbaEmulatorSession` implements the actions:

- `button_press` (with repeat; outcome reports
  moved/turned so a bump is distinguishable),
- `walk_to` — BFS route over the live collision
  grid, warp-aware (a blocked warp tile is
  approached and pressed into), refusals name
  the map bounds or nearest reachable tile,
- `select_menu_entry` — cursor walked press by
  press, verified against live state (XOR grid
  for battle menus, vertical lists otherwise),
- `advance_dialog` — reads a whole conversation
  to the next decision point, waits out
  script-held boxes, returns the transcript,
- `enter_text` — drives the naming keyboard
  verified key by key,
- `frame_advance`, cancellable `wait`.
  Observations: overworld (with minimap +
  exits), menu, party, inventory, battle,
  dialog, scene, frame_reference, danger,
  action.

Evidence policy: `frozen` (over budget =
uncertain, fail closed) vs `rolling` (seal the
window and keep playing; trace counts rolls).
Helpers exported: `planWalk` (BFS),
`planWalkBeside`, `nearestReachableDetail`,
`renderWalkabilityMinimap` (`@`/`.`/`#`/`D`
crop with `topLeft`), and
`validateGbaEmulatorTrace` which re-verifies
the whole hash chain. `closed()` errors use an
em-dash separator the free-play effect line
splits on.
