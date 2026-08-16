# packages/discord-presence-core/src/receipt-store.ts

`DiscordBridgeReceiptStore`: append-only,
single-writer JSONL evidence for both Discord
planes, written mode 0600 in a 0700 directory
with a symlink-refusing target check and fsync
per append.

`DiscordBridgeReceiptSchema` closes the type
enum: bridge/user-session lifecycle, text
ingress/reply, person-memory events, and the
`discord.voice.*` family (joined, consent,
utterance, floor, response, volition, overlap,
interrupted, failed, left, plus the possessor_*
seam events). Data is at most 16 scalar fields
(string ≤512 / boolean / finite number), and a
prefix-matched superRefine makes transcript/
response/prompt/audio/pcm/text/message/narration
keys unrepresentable in any voice receipt — the
content fence is in the schema, not the caller.
`parseDiscordBridgeReceipt` re-validates on read.
