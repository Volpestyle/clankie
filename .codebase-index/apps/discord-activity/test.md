# apps/discord-activity/test

Vitest suites: frame-hub.test.ts uses structural
viewers (no sockets); producer.test.ts opens real
loopback WebSockets against an ephemeral-port
server.

- frame-hub.test.ts — late-joiner state delivery,
  counted backpressure drops vs undroppable
  lifecycle, viewer cap, schema rejection
- producer.test.ts — bearer auth (including a
  shared-prefix token), malformed-frame
  filtering, disconnect → session_ended,
  loopback-only bind
