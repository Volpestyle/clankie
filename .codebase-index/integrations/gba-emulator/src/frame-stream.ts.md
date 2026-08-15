# integrations/gba-emulator/src/frame-stream.ts

`GbaFrameStream` — bounded, read-only frame
publisher for the watch-me-play activity
plane. Deliberately lossy: rate-limited
(default 50 ms ⇒ ~20 fps ceiling) and drops
frames whose encoded PNG is byte-identical to
the last, so an idle overworld costs nothing
to stream.

`capture(frameNumber, {force})` returns a
validated `RenderedSurfaceFrame` (base64 PNG,
digest, sequence) or null when rate-limited /
unchanged / unrendered; `force` gives a newly
joined viewer a full frame. Fails closed if a
frame would exceed the transport byte bound.
The source is a minimal `framebuffer()` view —
the stream never advances the core or inputs.
