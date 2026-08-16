# apps/discord-activity/src/index.ts

Entrypoint and barrel. When run directly: starts
the viewer server on CLANKIE_ACTIVITY_PORT
(default 4320), mints/resolves the producer
bearer via ensureActivityProducerCredential (the
activity server owns the listener, so it owns the
first-run mint — never from env), starts the
producer listener on CLANKIE_ACTIVITY_PRODUCER_PORT
(default 4322; 4321 collided with the captain),
and closes both on SIGINT/SIGTERM. Re-exports
RenderedSurfaceHub, createFrameProducerServer,
and createDiscordActivityServer.
