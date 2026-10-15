# Remote worker close and reload (VUH-2311)

A confirmed remote close could return `provenance_unknown: Original project
allocation changed` after closing the pane. Complete inventory first marked
its project allocation gone; completed-hire retirement then called the same
admission guard that required the allocation and pane to remain live. Pane tidy
interpreted that guard failure as a refusal and removed the close history.

A separate ordering defect ended the dedicated Codex controller before the
final close admission check. A refused close could therefore leave a live
native view without its backend.

The fix keeps admission checks before native effects and disposes the controller
after confirmed exit. Post-close receipt retirement uses its existing complete
census and unchanged configured-host checks. A failure there retains
`close_unconfirmed` history, rather than erasing an exit as a pre-effect refusal.
No process, ownership, worktree or host guard is relaxed.

## Retained incident evidence

Read-only inspection of the local service journals found the incident's original
project allocation marked gone, its original owner claim retained, a completed
hire receipt not retired, and no close-history entry. The resume has a separate
retained launch-committed receipt without a mapped pane. These facts match the
reproduced close path; they do not establish what the uncertain remote resume
started. No live journal was edited and no PC pane was contacted.

## Verification

The regression cases in `apps/clankie/test/pane-tidy.integration.test.ts` use
production native socket requests, fleet qualification, persisted ownership,
project allocations, completed-hire receipt goldens and close history. The Codex
server/view is the existing external protocol fixture, not a live Windows Codex
installation. Host receipt programs and Git run against owned temporary homes
and repositories on this Mac.

Against unchanged main, three cases fail: the exact allocation-changed error,
backend shutdown during a provenance refusal, and close/reload with retained
commits. With the fix:

- A completed project hire closes, releases its allocation, retires its receipt
  and retains closed history across reload.
- Final provenance refusal leaves allocation, ownership and receipt files byte
  identical, preserves the native roster and backend, and accepts a distinct
  message through the same controller afterward.
- A real linked Git worktree containing four clean unlanded commits refuses
  close without a reason, then closes with a retained explicit reason. Undo
  traverses ordinary `spawnSeat`/remote receipt/hire/resume code with the same
  native thread, fleet and working directory. All four commits and clean Git
  status survive. The fixture resumes without a new model turn.
- A changed host after exit keeps uncertain close history and does not retire
  the original receipt or allow Undo.
- An uncertain remote resume retains its exact failure. After service-state
  reload, observing the same thread in another pane records it reopened without
  a second hire.

Focused check: pane tidy, worker-tool refresh and remote-hire receipt integration
suites: **58 passed, 1 opt-in native case skipped**. Independent native Codex
review found no blocker. Full landing result and raw red/green logs are attached
on VUH-2311 with `clankie evidence push`.

## Live PC proof still required

After deployment, the lead must authorize a bounded observation/recovery of the
incident's original host and uncertain resume receipt. This assignment explicitly
forbids touching PC panes, so the following remains unperformed:

1. Read complete inventory and the original receipt on the unchanged configured
   host. Determine whether its original resume started the exact saved thread;
   inspect its original pane/process identity if present. Reconcile that receipt
   through the supported recovery path; do not repeat or replace its launch.
2. At an idle boundary, retain the worker's handoff and report, settle original
   receipts and verify no unsent draft. Keep the same saved thread, working
   directory, account home and four clean unlanded commits.
3. If the exact worker still needs a reload, use guarded `close_worker_pane`
   with an explicit reason for retaining those commits, require `closed`, and
   resume the fleet-qualified saved thread through `hire_agent` (or Undo within
   five minutes). Stop on any uncertainty and inspect its original receipt.
4. In that same resumed native thread, verify current plugin tools and send one
   distinct `message_clankie` report. Retain the stored receipt, thread/cwd proof
   and unchanged Git HEAD/status. A fixture pass or installed plugin version
   alone does not prove live tool exposure or report delivery.

Leave live acceptance open until that evidence is attached.
