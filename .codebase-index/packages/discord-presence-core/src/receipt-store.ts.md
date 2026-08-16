# packages/discord-presence-core/src/receipt-store.ts

`DiscordBridgeReceiptStore` appends single-writer
JSONL evidence for both Discord bodies, mode 0600
inside a 0700 directory, refusing symlink targets
and fsyncing each append.

`DiscordBridgeReceiptSchema` covers bridge/user-
session lifecycle, text and person-memory events,
stream-watch lifecycle/frame counters, and the
whole `discord.voice.*` pipeline: consent,
capture/transcription, floor decisions, model/
tool/music responses, playback, and possessor
seam events. Data is capped to 16 scalar fields.

Prefix-matched refinements make voice content
keys (transcript, response, prompt, audio, text,
message, narration) and stream payload keys
(frame/image/video/png/base64/pixels)
unrepresentable. `parseDiscordBridgeReceipt`
re-validates records on read.
