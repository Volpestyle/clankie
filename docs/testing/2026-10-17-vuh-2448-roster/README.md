# VUH-2448 — host fleet roster, Phase 1

Tracks: https://linear.app/vuhlp/issue/VUH-2448

The host publishes owner-only status counts by machine and lead, exact native
occupant IDs, last progress and observed inactivity. Retire and Undo use the
existing PaneTidy implementation behind close_worker_pane. The app's shared
shell is a separate change after VUH-2443.

## Evidence

`focused-rebased-tests.json`: 72 cases passed in five suites after rebasing onto
`12af00a42`, including VUH-2391's Herdr event observation and VUH-2456. A catalog
read followed by a native status change cannot authorize retirement from the
earlier idle count: both local and remote cases refresh to working and refuse.
The event feed's shared catalog census and slower bridge display inspection do
not replace the native status source or retirement's forced refresh. The action
uses upstream's `tidySessionKey`; the upstream automatic tidy/keep/report/draft
coverage and this feature's owner close/Undo round trip pass together.

`focused-status-tests.json`: 67 cases passed across the new
roster integration, owner-device authorization, native-socket close/Undo and
existing seat-efficiency integration suites. The count test compares the real
captain's projected roster with its native local and configured remote fixture
at the same read boundary. Status groups, the strict >1h threshold, restart,
occupant replacement, pending mail, retained host inactivity and remote-source
failure are covered. A local native read failure is also explicitly incomplete
and cannot authorize retirement. `focused-tests.json` retains the earlier
64-case run before that local-outage correction; `focused-outage-tests.json`
retains the 65-case outage run. Native `blocked` approval/question status counts
as waiting, and an idle native pane with a pending owner question is waiting,
pending and never stale or eligible for retirement.

The existing held-refresh shutdown regression passes after adding the roster
model’s close fence. An in-flight read cannot recreate persistence after Captain
closes. The exact-tree root gate also exercises this regression.

The retirement round trip uses production HTTP routing, the public CLI,
production orchestration, a private native socket, real ownership/report
journals and captured Codex draft ANSI. Missing kept reports and typed drafts
refuse without a close. A finished exact occupant closes once, returns the
five-minute deadline, and Undo reopens its saved session. Existing guard cases
retain coverage for dirty/unlanded work, unknown evidence and native processes.
No live owner panes were closed.

## Live parity follow-up

Core `f011bf889` was deployed with a healthy canary. Live Mac/PC reads match all
19 worker seats and occupants, but two stable PC `done` agents appear idle in
the host projection. A separate PC snapshot confirms `done`: native harness
idle enrichment was erasing completion. The projection now preserves Herdr
`done` when the harness is idle, while a working or blocked harness still wins.
Local and remote real-protocol regression cases fail before the fix and pass
after it. All 69 protocol, roster and close-guard cases pass together.
`live-parity-status-fix.json` retains the bracketed live reads, failing tests,
passing report and exact source patch. No live panes were closed.

The live host correctly reports unavailable `kh2` and a changing fleet cursor;
these partial reads do not establish complete fleet parity or enable retirement.
A deployed repeat remains pending.

## Gaps

This is fixture-backed host/API evidence. Live local-plus-PC count comparison,
and the deferred Mac UI capture remain part of VUH-2448. Isolated native iPhone
and iPad count/list/refusal/retire/Undo captures are attached to the issue from
the app branch; those do not establish live roster parity.
No core deployment or application release is established by these logs.
The exact-tree landing gate is recorded in `.local/landing-gate.json` in the
owned core worktree and reported with its checked SHA before any push.
