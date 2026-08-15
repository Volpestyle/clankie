# integrations/gba-emulator/src/naming-keyboard.ts

The FireRed naming-screen keyboard as pure
data plus single-step planning, empirically
verified against the pinned core: key grids
per page, the SELECT page cycle, wrapping
column rings (9 on letter pages, 7 on
symbols), and the OK button-strip position.

`findNamingKey` locates a character preferring
the current page; `stepTowardNamingKey`
returns the next d-pad press (columns first,
wrapping either way; rows direct, never
wrapping); `pageDistance` counts SELECT
presses. Deliberately conservative where the
probe left gaps — the adapter's `enter_text`
verifies every press against live state
anyway, so a wrong cell surfaces as an honest
stop, not a wrong name.
