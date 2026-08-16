# docs/adr/0097-herdr-lead-is-the-companion-dashboard.md

The operator console's herdr pane is Clankie's
fleet seat and the herdr-lead board is its companion
dashboard. A seated turn receives a live agent
census, the face reports `clankie`, and console
startup idempotently opens one board beside it.

The durable service remains outside any pane and
leads through bash plus the herdr CLI. Shell calls
use `herdr-lead split` / `state`, never bare
`herdr-lead`, which would start a TUI in-process
and hang the tool call.
