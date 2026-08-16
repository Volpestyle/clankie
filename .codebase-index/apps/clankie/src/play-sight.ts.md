# apps/clankie/src/play-sight.ts

`PlaySightProjection` is the in-process, pull-when-needed view of a live playthrough. The play execution attaches a PNG capture, journal path, and progress while running; HTTP routes and captain tools can request a still or bounded story without reaching into the emulator.

Detaching clears the live handles, and mismatched session identity fails closed.
