# apps/tui/src/session

The console's clients for the clankie service and the
render-only trace pipeline.

Children:

- `operator-conversations.ts` — the production
  conversation path: authenticated route fetcher,
  dispatch client, selection + tail stores,
  `OperatorConversationPromptSession`.
- `operator-conversation-renderer.ts` — event union →
  transcript markdown, plus the shell sink with
  local-echo suppression.
- `lane-observation.ts` — `/trace`: the lane listing
  client, selection/formatting, `followLane` polling,
  and the multi-lane trace controller (ADR 0083).
- `captain-stream.ts` — the structural session-event
  types kept as the trace transport seam (no live
  transport yet).
- `trace-renderer.ts` — event → redacted human/JSON
  lines with typed lane tags.
- `trace-types.ts` — the frozen lane enum and
  identity-only `TraceCursor`.
- `trace-cursor.ts` / `session-cursor.ts` —
  mode-0600 atomic checkpoint stores (identity only,
  never payloads).
- `herdr-report.ts` — pane agent/metadata
  self-reporting, inert outside HERDR_ENV=1.

Everything durable is fail-closed and 0600; the
conversation path snapshots the selection per prompt
and consumes the typed tail until the accepted run's
terminal lifecycle event.
