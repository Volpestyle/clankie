# apps/discord-activity/src

The surface's four pieces plus the entrypoint.

- index.ts — standalone entrypoint: viewer on
  :4320, broker-minted producer bearer, producer
  on loopback :4322
- frame-hub.ts — RenderedSurfaceHub, latest-only
  fan-out with backpressure drops and a viewer
  cap
- server.ts — viewer HTTP/WS server serving
  client.html and `/.proxy/frames`
- producer.ts — loopback, bearer-authenticated
  frame ingress; newest producer owns the session
- client.html — the iframe page: pixelated canvas
  - lower third, self-reconnecting

Flow: the emulator host dials the producer socket
and sends validated frame/overlay/stopped
messages; the hub keeps only the latest of each
and broadcasts to viewers (late joiners get the
current state immediately); the client renders
frames by sequence and shows objective/thought/
intent/effect, with a v1 free-form-lines overlay
fallback. Producer disconnect stops the surface
for everyone.
