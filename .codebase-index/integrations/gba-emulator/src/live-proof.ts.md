# integrations/gba-emulator/src/live-proof.ts

`evaluateFireRedLiveReceipt` — re-verifies an
existing operator-local live-proof receipt for
the `firered-oaks-lab-rival` scenario without
reopening ROM or savestate bytes.

Parses the strict content-free receipt schema,
rejects symlinks and oversized files, then
recomputes the SHA-256 of every referenced
artifact (report, decisions, events, semantic
events, final-frame screenshot) beside the
receipt and checks: scenario passed and halted
on the won battle, all gameplay checks true,
two fresh cores byte-identical, and zero
network attempts. Returns a pass/fail report
listing each check plus the run's identity
digests.
