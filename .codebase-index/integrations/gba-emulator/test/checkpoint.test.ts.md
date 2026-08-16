# integrations/gba-emulator/test/checkpoint.test.ts

Tests minted checkpoints: writing mints a
bootable sibling identity (savestate +
receipt + companion scenario) rather than
mutating the pinned one; listing skips foreign
directories; loading refuses path-shaped ids,
receipts naming another directory, a different
ROM or core build, and corrupt savestate
bytes.
