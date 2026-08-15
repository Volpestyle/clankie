# docs/adr/0055-launcher-owned-local-services.md

The TUI launcher supervises every local service,
not just the captain: `clankie restart` walks the
dependency order and stops at the first failure;
`clankie down` walks the reverse; `clankie
status` reports all services.

Read for the supervision rules, each earned by a
failure: an atomic mode-0600 pid record per
service, an ownership check before any signal
(recycled pids), and a health gate on start (a
spawn is not a restart). Services started outside
the launcher are reported, never adopted or
killed. Bridge health reads a redacted
operator-scoped presence-status route, not the
captain-scoped session records.
