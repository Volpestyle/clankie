# packages/rendered-surface-client

Runner-side producer client for the Discord
activity plane (ADR 0047): a WebSocket sink that
publishes encoded gameplay frames and the
decoded-state overlay to the activity server. The
runner dials out to a loopback producer endpoint
with a broker-resolved bearer — the credential-
holding process never opens a port for an
internet-facing surface to connect into.

Children:

- `package.json` — @clankie/rendered-surface-client
- `src/` — the activity frame sink
- `test/` — sink behavior suite
- `tsconfig.json` — standard noEmit config

Design points:

- Lossy on purpose: frames are dropped (and
  counted via `droppedFrameCount`) while the
  socket is not open, so a reconnecting viewer
  resumes at the present moment instead of
  replaying a stale playthrough.
- `createBrokeredActivityFrameSink` resolves the
  producer bearer and returns undefined when the
  activity plane was never bootstrapped
  (deny-by-default: no credential, publish
  nothing).
- Frame/overlay shapes come from
  `@clankie/interactive-environment`
  (`RenderedSurfaceFrame`,
  `RenderedSurfaceOverlay`).
