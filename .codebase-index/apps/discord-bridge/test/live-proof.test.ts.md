# apps/discord-bridge/test/live-proof.test.ts

Covers all three receipt-log evaluators: text
proof requires a settled admitted delivery with a
reply id (partial receipts fail); person-memory
proof requires the exact fact id recalled from a
different service instance (same-boot recall and
unrelated facts fail); voice proof requires the
full three-speaker DAVE ceremony, evaluates the
latest qualifying session in a cumulative log, and
rejects synthetic single-speaker runs, older
ceremonies masking newer failures, and refused
possessor narrations. An absent receipt file is
incomplete evidence, not an error.
