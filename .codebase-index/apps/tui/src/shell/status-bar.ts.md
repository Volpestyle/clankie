# apps/tui/src/shell/status-bar.ts

`ClankieStatusBarComponent` renders ANSI-aware wrapped status text, capped at six rows with an ellipsis. `formatCaptainPresenceStatus()` shows the polled Discord phase; `formatCaptainContextStatus()` and `formatCaptainContextUsage()` render current operator-conversation token occupancy/compaction state without exposing content.

`formatStatusRows()` is the pure width-budget helper used by the shell and tests.
