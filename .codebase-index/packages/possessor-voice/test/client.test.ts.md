# packages/possessor-voice/test/client.test.ts

Client suite over a controllable fake socket.
Covers: bearer presentation and bounded/trimmed
narrate payloads; refusing (not queueing) when the
bridge is unreachable; refusing over-length
narration instead of truncating; forwarding an
optional journal delivery id; delivering room
utterances to subscribers and stopping on
unsubscribe; ignoring malformed/off-contract
messages; tracking the `room` listening flag
without treating it as an utterance; reverting
`roomListening` to false when the seam drops; and
scheduling a reconnect after close.
