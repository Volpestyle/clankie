# integrations/gba-emulator/src/body-lock.ts

Pure re-export of the cross-process body mutex
from `@clankie/body-lock` (`acquireBodyLock`,
`observeBodyHolder`, `BodyBusyError`, types).
The mutex lives in its own package so
observability surfaces can read who holds the
body without importing the emulator; this file
keeps existing in-package and barrel imports
working.
