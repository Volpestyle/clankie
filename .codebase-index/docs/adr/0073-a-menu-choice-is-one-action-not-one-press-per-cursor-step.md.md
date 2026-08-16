# docs/adr/0073-a-menu-choice-is-one-action-not-one-press-per-cursor-step.md

`select_menu_entry`: given an `entryId` from the
open menu's observation, walk the cursor there
and press A, verifying against live cursor state
between presses. The caller still chooses; the
action only carries the cursor.

Read for the geometry (battle menus are 2×2 XOR
grids, everything else a vertical list; a
non-fitting menu stops as `cursor_stalled`
without pressing A) and the fail-closed refusals
(`menu_not_open`, `menu_entry_not_found`,
`menu_not_navigable`, scrolled bag windows).
Maps to the existing input capability; frozen
receipts untouched.
