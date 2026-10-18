# VUH-2448 — host fleet roster, Phase 1

Tracks: https://linear.app/vuhlp/issue/VUH-2448

The host publishes owner-only status counts by machine and lead, exact native
occupant IDs, last progress and observed inactivity. Retire and Undo use the
existing PaneTidy implementation behind close_worker_pane. The app's shared
shell is a separate change after VUH-2443.

## Evidence

`focused-tests.json`: 64 cases passed across the new
roster integration, owner-device authorization, native-socket close/Undo and
existing seat-efficiency integration suites. The count test compares the real
captain's projected roster with its native local and configured remote fixture
at the same read boundary. Status groups, the strict >1h threshold, restart,
occupant replacement, pending mail, retained host inactivity and remote-source
failure are covered.

The retirement round trip uses production HTTP routing, the public CLI,
production orchestration, a private native socket, real ownership/report
journals and captured Codex draft ANSI. Missing kept reports and typed drafts
refuse without a close. A finished exact occupant closes once, returns the
five-minute deadline, and Undo reopens its saved session. Existing guard cases
retain coverage for dirty/unlanded work, unknown evidence and native processes.
No live owner panes were closed.

## Gaps

This is fixture-backed host/API evidence. Live local-plus-PC count comparison,
iPhone/iPad/Mac UI captures, and the UI retire journey remain part of VUH-2448.
No core deployment or application release is established by these logs.
The exact-tree landing gate is recorded in `.local/landing-gate.json` in the
owned core worktree and reported with its checked SHA before any push.
