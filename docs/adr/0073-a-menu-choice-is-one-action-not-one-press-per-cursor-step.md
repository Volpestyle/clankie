# 0073. A menu choice is one action, not one press per cursor step

Date: 2026-08-01
Status: accepted

## Context

[ADR 0066](0066-dialog-is-one-action-not-one-press-per-box.md) collapsed
reading a conversation into one catalogued action, on the principle that a
driver's decision budget should be spent on decisions. Menus never got the same
treatment: once he has decided which battle move to use, expressing that choice
still costs one full decision per cursor step plus one for the confirming A —
each a model call with a screenshot, at several seconds per turn with an
audience watching. The 2026-07-27 asked-play journals show tutorial battles
spent almost entirely on single presses inside menus whose outcome he had
already chosen.

The decoded menu state already carries everything a composite needs: `menuId`,
the live `cursor`, and `entries` with stable ids — the same ids the menu
observation shows the model.

## Decision

Add `select_menu_entry` to the catalogued action schema: given an `entryId`
from the open menu's observation, walk the cursor to that entry and press A,
verifying the cursor against live state between presses.

- **It never chooses.** The caller names the entry; the action only carries
  the cursor there. A menu appearing is still a decision point, exactly as
  `advance_dialog` leaves it.
- **Geometry is decoded, not guessed.** The battle action and move menus are
  2×2 grids whose cursor moves by XOR — left/right flip bit 0, up/down flip
  bit 1, matching the game's own cursor code; every other decoded menu is a
  vertical list. Each press is verified against the live cursor: a menu whose
  geometry does not fit the model stops the action as `cursor_stalled` instead
  of wandering.
- **It stops and says why** (`endedBecause`): `selected`, `menu_closed`,
  `cursor_stalled`, or an exhausted input/frame budget. A stop never presses
  the confirming A, so a stall cannot select an entry the caller does not name.
- **Fail-closed refusals** before any press: `menu_not_open`,
  `menu_entry_not_found`, `menu_not_navigable` (the naming screen belongs to
  `enter_text`), and `menu_window_scrolled` — bag windows are a 16-entry slice
  under an absolute cursor, so a full window cannot be navigated by entry
  index and is steered with single presses instead.
- **No new capability.** A menu choice is cursor presses and an A, so it maps
  to `emulator.gba.input` exactly as `walk_to`, `advance_dialog`, and
  `enter_text` do.
- The evidence event `actionKind` enum gains the new kind, the same additive
  extension used by `advance_dialog` and `enter_text`. Frozen receipts are
  untouched: their runs never emit it.

Both driver wires offer it — the free-play flat schema and the MCP
`start_action` arguments — with the free-play effect line reporting the choice
(`chose "…" in battle-move-menu`) rather than the diff's "menu changed".

## Consequences

- Choosing a battle move costs one decision instead of three to five. The
  press-by-press path remains available for menus the composite refuses.
- A scripted-menu core in `test/select-menu-entry.test.ts` pins the XOR grid,
  the list walk, and every stop shape, mirroring the scripted dialog core.
- The bag refusal is deliberately conservative: a scrolled window is refused
  rather than mis-navigated. Decoding absolute pocket indexes so long lists
  compose too is a separate change if it earns its keep.
