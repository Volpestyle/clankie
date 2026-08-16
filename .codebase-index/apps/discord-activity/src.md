# apps/discord-activity/src

The watch surface's complete runtime.

- `index.ts` — starts viewer `:4320` and loopback producer `:4322`, resolving the brokered producer bearer.
- `frame-hub.ts` — `RenderedSurfaceHub`, latest-only fan-out, viewer cap/backpressure counters, and current PNG snapshot.
- `server.ts` — public client/page and viewer WebSocket server with Discord proxy-path support.
- `producer.ts` — loopback-only authenticated frame ingress plus snapshot response.
- `client.html` — reconnecting pixelated canvas, live lower third, and presentation controls.

Producer messages validate through shared protocol schemas; the hub broadcasts current state to late joiners and ends every viewer when the owning producer stops.
