# apps/discord-activity/test

Offline Vitest suites for the rendering plane.

- `frame-hub.test.ts` — current-state delivery, session replacement, snapshot access, schema rejection, viewer cap, backpressure drops, lifecycle fan-out.
- `producer.test.ts` — loopback bind, exact bearer auth, malformed-frame filtering, authenticated snapshot reads, and disconnect-to-ended behavior over real ephemeral WebSockets.
