# integrations/gba-emulator/src/firered-state.ts

The full version-pinned RAM/ROM profile for
Pokémon FireRed (U) v1.0 (`decodeFireRedState`)
— parties, battles, dialog, menus, the naming
screen, inventory, and map identity, all from
EWRAM+IWRAM snapshots plus the ROM. Every
decoder validates checksums, bounds, and enum
domains before returning state; anything
uncertain throws.

Decodes: encrypted party records (personality
XOR otId, substruct permutation table, secure
checksum), battle state (gBattleMons, battler
positions, action/move cursors, exec flags →
action/move/resolving input mode, outcome),
move power straight from the ROM table,
Gen III text (charmap incl. accents and
control codes), field dialog with the
wait-for-A/B script native detected so
`waitingForDialogAdvance` is honest, start/
party/bag/battle menus (bag windows scroll:
entries are a 16-slice while the cursor stays
absolute), the naming screen (typed bytes,
keyboard page, cursor from gSprites data
words, and what is being named), inventory
with the save-block quantity key, map identity
from SaveBlock1, and `fieldInputReady` (the
overworld callback active and field controls
unlocked). Exports `FIRERED_US_V10_ROM_SHA256`
and `fireRedMapIdFor` (known map-id table:
pallet-town, route-1, the houses, Oak's lab).
