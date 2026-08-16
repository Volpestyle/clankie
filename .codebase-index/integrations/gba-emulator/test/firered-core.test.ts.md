# integrations/gba-emulator/test/firered-core.test.ts

Pins `battleModeForOutcome`: every
engine-defined gBattleOutcome maps without
throwing — 1 won, 2/9 lost, everything else
(ran, caught, fled…) stays "battle" so exit
text remains advanceable. A successful Run
once threw here and froze all input.
