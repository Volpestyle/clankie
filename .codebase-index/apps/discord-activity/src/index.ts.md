# apps/discord-activity/src/index.ts

Standalone entrypoint and barrel exports. It starts the public viewer server on `:4320`, resolves/mints the producer credential in the broker, starts the loopback producer/snapshot server on `:4322`, and closes both on signals.

Re-exports `RenderedSurfaceHub`, `createFrameProducerServer`, and `createDiscordActivityServer` for tests and embedded use.
