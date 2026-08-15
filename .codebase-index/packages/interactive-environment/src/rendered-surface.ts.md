# packages/interactive-environment/src/rendered-surface.ts

Frame transport schemas for the activity plane
(ADR 0047). The emulator core, ROM, and savestate
stay on the host; only encoded frames cross.

- `RenderedSurfaceFrameSchema` — one base64 PNG
  frame with monotonic sequence, emulator frame
  counter, dimensions, sha256, and a refinement
  that the decoded length matches `byteLength`
  (max 256 KB via
  `RENDERED_SURFACE_FRAME_MAX_BYTES`).
- Overlay, versioned independently:
  `RenderedSurfaceOverlayV1Schema` (legacy
  free-form `lines` — accepted, never produced)
  and `RenderedSurfaceOverlayV2Schema` (structured
  objective/intent/monologue/effect turn fields,
  each ≤256 chars — bounded model text is the
  point, ADR 0049). V2 tolerates a stale
  schemaVersion 1 stamp on the structured shape
  and normalizes it to 2 in the parse.
- `RenderedSurfaceMessageSchema` — the wire
  envelope: frame | overlay | stopped
  (operator_stop / session_ended).
- `RENDERED_SURFACE_QUEUE_MAX` — per-viewer
  buffering ceiling before oldest frames drop.
