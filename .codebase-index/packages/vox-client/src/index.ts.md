# packages/vox-client/src/index.ts

Exports `VoxStreamClient` for watch/publish consumers and the full `VoxClient` voice/audio/music surface, plus `createVoxClient`, binary resolution helpers, `VoxFrameDecoder`, media event decoders, and `sanitizeVoxLog`. The child receives capped NDJSON commands; stdout uses five-byte format/length frames for JSON control or binary speaker PCM, and stderr is URL/credential-redacted before callbacks.

Reliable commands queue up to 256 while stdin is blocked, whereas audio and browser-frame commands drop under pressure; browser base64 is capped at 7.5 million characters and all command lines at 8 MiB. `close()` sends `destroy`, waits two seconds, then sends SIGTERM if needed. Control JSON is intentionally shape-light beyond a nonempty `type`, while video/audio decoders validate the fields and 18-byte PCM header they consume.
