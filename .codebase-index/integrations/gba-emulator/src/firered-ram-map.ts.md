# integrations/gba-emulator/src/firered-ram-map.ts

FireRed EWRAM/IWRAM map — exactly the fields
the real core decodes, every offset verified
empirically against the pinned ROM by input
differencing (and corroborated by the
pokefirered decompilation).

Decodes:

- player tile coords + facing
  (`decodeFireRedOverworld`, EWRAM 0x36e48/
  0x36e58),
- the live map buffer `gBackupMapLayout`
  (IWRAM 0x5040): `decodeFireRedMapGrid`
  yields the border-inclusive tile grid; each
  u16 tile packs metatile id / collision /
  elevation. The 7-tile border decodes as
  collision 0, so `isInsideFireRedMap` is
  load-bearing — without it the void reads as
  open floor. `isFireRedTilePassable`,
  `fireRedSurroundings` (the 4 neighbours plus
  the faced tile),
- every exit via `gMapHeader` (EWRAM 0x36dfc):
  `decodeFireRedMapExits` reads warp events
  and edge connections out of ROM pointers,
  returning null (never a guess) when the
  header is mid-warp or implausible.

All decoders fail closed on out-of-range
dimensions, non-EWRAM pointers, or unknown
enum bytes. Collision models walls only —
not ledges, water, or NPCs.
