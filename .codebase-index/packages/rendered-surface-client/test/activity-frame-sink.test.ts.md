# packages/rendered-surface-client/test/activity-frame-sink.test.ts

Sink suite over a controllable fake socket, with
a helper building valid `RenderedSurfaceFrame`
fixtures (sha256-hashed PNG bytes). Covers:
bearer presentation and frame publishing while
connected; dropping (never buffering) frames
while disconnected, with an honest drop count;
and reconnect scheduling after a socket close that
stops once the sink is explicitly closed.
