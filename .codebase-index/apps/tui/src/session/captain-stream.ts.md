# apps/tui/src/session/captain-stream.ts

Local structural types for a captain session event
stream — the transport seam `clankie trace` renders
through. The pi-based service does not expose this
stream yet; any client yielding these events can
drive the renderer.

`CaptainStreamEvent` is a permissive discriminated
union (reasoning/message deltas, actions requested
and results, step/turn/session lifecycle, compaction;
unknown types render via the `other` branch), with
`CaptainStreamAction`/`ActionResult` covering
tool/skill/subagent/remote-agent calls.
`CaptainSessionClient` is the one-method interface
(`session(state).stream(options)`).
