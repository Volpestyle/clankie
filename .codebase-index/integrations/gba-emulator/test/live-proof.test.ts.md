# integrations/gba-emulator/test/live-proof.test.ts

Tests `evaluateFireRedLiveReceipt` on
synthesized receipt directories: a complete
valid rival-battle proof passes; a changed
artifact fails its recomputed hash; a
symlinked receipt file is rejected outright.
