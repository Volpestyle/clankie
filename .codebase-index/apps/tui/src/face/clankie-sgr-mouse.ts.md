# apps/tui/src/face/clankie-sgr-mouse.ts

Parser for SGR mouse escape sequences
(`\x1b[<b;c;rM/m`). `parseClankieSgrMouse` classifies
press/drag/release/wheel from the button flags
(motion bit 32, wheel bit 64; wheel notches arrive as
press reports), returning 1-based col/row;
`isClankieLeftMouseButton` masks the button bits.
Sole input parser behind transcript selection,
scrollbar drags, and chrome selection.
