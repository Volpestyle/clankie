# integrations/gba-emulator/test/free-play-boot.test.ts

Tests `bootGbaGame` path resolution: the
XDG-aware game home, falling back to the
deterministic double when no operator files
exist, and refusing Emerald with a clear error
when its ROM or savestate is absent.
