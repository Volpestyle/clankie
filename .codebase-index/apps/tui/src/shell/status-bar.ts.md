# apps/tui/src/shell/status-bar.ts

The status band. `ClankieStatusBarComponent` renders
whatever text the shell sets, wrapping long lines
(ANSI-aware) instead of clipping, capped at 6 rows
with an ellipsis on the last; leading/trailing
newlines become spacer rows. `formatStatusRows` is
the pure helper; `formatCaptainPresenceStatus`
renders the polled presence snapshot as
`clankie: <phase>` (`unknown` when the poller has
nothing).
