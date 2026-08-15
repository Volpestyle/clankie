# integrations/gba-emulator/scripts/run-real-scenario.ts

`gameplay:live-proof` — the ROM-gated real-core
proof. Runs the selected FireRed scenario
TWICE against two freshly created cores and
requires byte-identical report, decision
trace, and event trace.

A runtime no-network tripwire monkey-patches
fetch, net.Socket.connect, and dns.lookup
before anything runs; any attempt fails the
run. Writes report/decisions/events/semantic
events/final-frame PNG plus a `run-receipt.json`
(identities, determinism digests, artifact
hashes) into `CLANKIE_GBA_RECEIPT_DIR` — never
into the repo, never containing ROM or
savestate bytes. Exit 0 only when passed,
deterministic, and zero network attempts.
