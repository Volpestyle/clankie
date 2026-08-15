# apps/tui/src/session/trace-types.ts

The typed captain lane labels for the trace surface:
`TRACE_LANES = ["tui", "discord_voice",
"discord_presence", "gameplay"]` with
`isTraceLane`/`parseTraceLane`. Lane identity comes
only from session/event context or explicit flags —
never inferred from prose. Also defines the
identity-only `TraceCursor` (version, generation,
sessionId, streamIndex, lane, active — no payloads)
and `TracedStreamEvent`.
