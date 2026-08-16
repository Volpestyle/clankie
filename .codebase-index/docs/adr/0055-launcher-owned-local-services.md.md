# docs/adr/0055-launcher-owned-local-services.md

The TUI launcher supervises the one `clankie`
backend plus its dependent Discord bodies,
activity surface, and tunnel. `clankie restart`
walks dependency order, `down` reverses it, and
`status` reports every declared service; legacy
captain/control-plane names are aliases for the
same backend.

Read for the supervision rules, each earned by a
failure: an atomic mode-0600 pid record per
service, an ownership check before any signal
(recycled pids), and a health gate on start (a
spawn is not a restart). Services started outside
the launcher are reported, never adopted or
killed. Bridge health reads a redacted
operator-scoped presence-status route, not the
captain-scoped session records.
