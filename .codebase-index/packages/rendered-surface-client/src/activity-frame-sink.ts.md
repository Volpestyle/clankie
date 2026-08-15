# packages/rendered-surface-client/src/activity-frame-sink.ts

The activity-plane producer sink (ADR 0047).

Exports:

- `createActivityFrameSink({url, token, ...})` →
  `ActivityFrameSink` with `publishFrame(frame)`,
  `publishOverlay(overlay)` (the sidecar carrying
  bounded model text per ADR 0049),
  `droppedFrameCount`, `connected`, `close()`.
- `createBrokeredActivityFrameSink(options)` —
  resolves the bearer via
  `resolveActivityProducerCredential()`; undefined
  when no credential exists.
- `ActivityFrameSocket` — structural socket view
  so tests never open a real one.

Mechanics: dials the producer endpoint (e.g.
`ws://127.0.0.1:4321/producer`) with the bearer in
an Authorization header; messages are JSON
`{kind: "frame"|"overlay", ...}`. Sends while the
socket is OPEN, otherwise increments the drop
counter — nothing is buffered. Reconnects on close
with a fixed delay (injectable timer), stops after
an explicit `close()`.
