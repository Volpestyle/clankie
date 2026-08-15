# integrations/gba-emulator/test/enter-text.test.ts

Tests `enter_text` against a scripted naming
screen modeled exactly as the 2026-07-26 RAM
probe verified it: wrapping column rings,
SELECT page swaps that eat d-pad input for ~30
frames, START jumping to OK, and A on OK
closing the screen. The test's key grids are
transcribed independently from the probe
report, so a typo in the production layout
tables fails here instead of being mirrored.
Covers prefix-idempotent resume, wrong-prefix
erasure, budget stops, and unregistered-press
honesty.
