# apps/discord-bridge/src/live-proof.ts

Evaluators that turn the bridge's JSONL receipt
log into pass/fail proof reports — partial or
fixture-only receipts cannot pass.

- evaluateDiscordLiveProof: gateway ready plus one
  admitted delivery that both settled and produced
  a Discord reply id.
- evaluateDiscordPersonMemoryLiveProof: a proposal
  whose exact fact id was later recalled from a
  different service instance (proves durable
  restart, not process RAM).
- evaluateDiscordVoiceLiveProof: reconstructs
  voice sessions from joined/left receipts
  (selectVoiceProofSession picks the latest
  ceremony candidate so a trailing clean
  reconnect doesn't displace the main proof, and
  stale success can't mask a newer failure), then
  requires a positive DAVE version, three unique
  consents, three attributed answered speakers,
  zero failures, an overlap plus an interruption,
  a clean leave, possessor room state and two-way
  narration delivery with no refusals, and a
  same-scope DAVE leave/rejoin recovery.

readDiscordLiveReceipts loads and parses the log
(regular file only, no symlinks, 10 MiB cap;
absent file is empty evidence).
