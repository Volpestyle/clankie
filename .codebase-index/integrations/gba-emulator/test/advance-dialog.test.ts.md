# integrations/gba-emulator/test/advance-dialog.test.ts

Tests `advance_dialog` (one action reads a
whole conversation) against a scripted seam
core built to control the stops: a choice
opening, the box closing, script-held boxless
screens, battle text, and exhausted input/
frame budgets. Also checks the transcript
capture (mid-print prefixes replaced, not
duplicated) and the effect line via
`observeEffect`. The frozen double covers the
end-to-end path.
