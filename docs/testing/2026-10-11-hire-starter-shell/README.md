# VUH-2031 hire-created starter shells

Tracks: https://linear.app/vuhlp/issue/VUH-2031/hires-leave-a-blank-starter-shell-behind-in-every-new-herdr-workspace

Confirmed on fetched main `f87cdbe4f`: workspace creation allocated a blank
`Clankie` starter tab before allocating the hire's separate tab.

The allocator now creates only its hire pane, then moves that new pane into
its repo workspace. Herdr creates the workspace around the existing terminal,
with no starter shell. Existing owner panes are never cleanup targets.
A lost cross-workspace move reply stays unresolved instead of associating the
hire with its obsolete pane ID and allowing another allocation.

The real isolated Herdr CLI/socket journey covers one- and two-hire workspaces,
prepared initial commands retaining their terminal and PID across the move,
closing the sole allocation without leaving a shell, preservation of an owner's
unsent shell draft, and lost-reply persistence across a store restart.

## Residual edge

Per lead direction, a completely empty Herdr server retains the old first-hire
workspace-create fallback, including its starter shell. Herdr needs an existing
workspace to stage an initial-command tab. The journey proves the first prepared
command still launches there. This avoids breaking fresh installs; it does not
claim that first-ever starter shell is removed. Historical blank shells are not
adopted or inferred safe to close.

## Final checks and live proof

Passed:

- Focused Herdr journey, worker-account and OpenCode lifecycle integration checks:
  3 files, 35 tests, exit 0 (119.50 seconds).
- Final real Herdr journey after the last source edit and formatting: 1 test,
  exit 0 (7.67 seconds).
- Service TypeScript check: exit 0.
- Touched-file formatting and `git diff --check`: exit 0.

The live native Codex proof passed through `clankie heavy`: workspace `w4J`
contained only hired pane `w4J:p1` (terminal `term_65d8af90d132b14e`). Its original
startup first returned pending; the proof kept it alive, observed the same native
session `01a129b9-1281-7170-bd45-d883c7565d94`, attached its adapter control and
waited for settlement without another hire or brief. Codex's model-migration
dialog was acknowledged in that owned pane. Closing its controller and pane left
no panes in `w4J`, and all 19 pre-existing panes retained their terminal IDs.
`vuh-2031-live-native-hire.json` attached to VUH-2031 (attachment
`f2f1ea8b-5d28-4503-a0df-12447954c5e4`) preserves the initial pending receipt
as well as reconciliation. The local proof script and raw logs remain in
ignored `.local/vuh-2031-proof/`; the evidence media scanner does not ingest JSON
or text logs, so this small JSON was attached directly to Linear.

The authoritative exact-tree gate and push run through plain
`clankie integrate --push`; its final receipt is recorded on the issue.
The proof runner initially mishandled an empty CLI metadata reply, then exited
while Codex awaited hook review. Both attempts' own panes were inspected and
closed; the original private app-server of the second attempt was verified by
its pane's socket before termination. No existing pane was closed and no
uncertain hire was repeated.
