# integrations/gba-emulator/test/map-exits.test.ts

Tests exit decoding: `decodeFireRedMapExits`
against synthetic EWRAM+ROM (warps, edge
connections, a dive connection that is not an
exit, and null on every implausible pointer or
out-of-map coordinate), `fireRedMapIdFor`
naming, and the adapter's overworld exits/
warp-aware `walk_to` behavior through a
scripted core. Real-ROM verification joins
when the ROM env vars are set.
