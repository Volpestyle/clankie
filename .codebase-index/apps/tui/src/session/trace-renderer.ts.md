# apps/tui/src/session/trace-renderer.ts

Pure rendering for the trace surface:
`renderTraceEvent` turns one lane-tagged
`CaptainStreamEvent` into typed `TraceRenderLine`s
(reasoning, tool_call `name(args)`, tool_result
previews, message, turn/session boundaries, tokens,
compaction, other) with both a human text form and a
JSON object; `formatTraceLines` picks the mode
(human dims reasoning; json emits one object per
line).

All tool inputs/outputs pass through
`@clankie/observability`'s
`sanitizeForSupportBundle` before display — secrets
like Authorization headers render `[REDACTED]`; no
local secret-key list. Args are capped at 320 chars,
result previews at 240. Never writes to disk.
