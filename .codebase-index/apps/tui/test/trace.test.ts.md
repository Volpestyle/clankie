# apps/tui/test/trace.test.ts

The render-only trace surface: `renderTraceEvent`
line kinds and lane tags, secret redaction (a bearer
token in tool args must render `[REDACTED]`),
`processTraceStream` cursor advancement across turn
boundaries without exiting, the identity-only
cursor stores (0600, payload-free on disk,
invalid-schema raising), `clankie trace` CLI runs
with a fake session client (session adoption by
generation, reconnect, `--timeout` → 124), and
herdr pane reporting.
