# Fleet tools

The mechanics behind [lead](../SKILL.md). `hire_agent` starts a visible native
worker in a Herdr pane, `message_seat` carries assignments and answers, and
workers report with `message_clankie`. Herdr is the terminal runtime and an
inspection surface, never the message transport. Exact flags and fields:
`docs/cli.md` under the `repoRoot` that `clankie doctor --json` reports.

## Hiring

Give a hire a short human name, role, owned checkout and paths, result and
acceptance. `hire_agent` resolves explicit owner-authorized fields, then the
project's role preferences, then `fleet.hire` defaults: omit harness, model,
effort, account and placement to inherit, and inspect the returned `profile`.
A cross-family model override includes its matching harness; friendly model
names are registry-validated and refuse when missing or retired. Project and
role caps count starting, live and uncertain seats, and a finished turn still
holds its pane and slot. `clankie fleet status` shows effective profiles; the
owner edits them with `clankie agents role ROLE --project PROJECT` or
`/agents roles`, where `auto` model or effort means no preference. With no
preference, pass a model or effort only when you choose one for that task.

Changing `clankie model` or `clankie effort` tunes Clankie's own turns, not an
external worker. A pane label or a brief asking for effort is not
configuration. No tool lowers a running worker's effort: ask it through its
native channel, or keep its handoff and re-hire.

A `native-first` role uses one stable `deliverable` key, normally the issue ID.
Its worker owns the slices through its own native subagents, passing the
configured child model and effort. Another pane for that deliverable is refused
while one is starting, live or uncertain: message the existing worker rather
than inventing a new key. `panes` lets independently owned slices have separate
hires.

Placement: one workspace per repository in the selected fleet (linked worktrees
share it); `new-tab` is normal, one worker per tab named `Name · role`. A shared
workflow passes an explicit named `pipeline`: its first member creates the tab
and later stages `split` into it. Tabs need matching repo and pipeline metadata
on every pane; unmarked or ambiguous tabs refuse. Never substitute the lead's or
the focused pane. Registered local account labels select existing profiles;
remote account overrides are unsupported.

## Report routing

The hiring conversation owns the worker and receives its reports and hire
completion. A host-admitted `message_seat` from another conversation adopts it.
Without persisted adoption, reports follow the actual census parent or launcher
pane to its attached conversation or native channel; explicit adoption wins.
With no eligible parent, `global-default` receives the report tagged
`unadopted`. The worker never chooses its destination, and names, tabs and
report text prove no ownership. `workerReportRouting` on the roster and
`linkedSession.parentLeads` in doctor show the route and any lead pane missing a
bridge. `readopt_seat({ seatId })` refreshes this conversation's own ownership
from fresh host proof after a legitimate reattach; it adopts nobody else's
worker. An attached native operator seat receives its selected conversation's
reports, wakes and watches; attachment adds no room or machine grants.

Remote seat IDs keep their fleet prefix (`studio/term_…`); a local pane ID is a
different terminal. A Codex session you did not start on another machine
receives `message_seat` through that machine's `codex queue`.

## Watching and harvesting

Use the returned seat ID with `herdr_watch` when a completion watch is needed,
and reuse an existing one. An accepted Codex follow-up arms a harvest for its
exact native turn, so add no explicit watch for it. Peer messages and
reconciled receipts arm nothing.

Read retained reports with `worker_reports({ limit: 20 })`, then acknowledge
each one you reviewed with `acknowledge_worker_reports({ deliveryIds: [...] })`.
A native receipt does not clear unread state; never acknowledge truncated
output. Acknowledgment adds no progress, and an unread report does not prove a
stall.

## Receipts, questions and recovery

Stored means retained, delivered means transport delivery, consumed means the
native receiver accepted it: none proves the model read or finished it. An
active Codex steer differs from an after-turn queue; keep that detail.

Hired Codex questions reach the hiring conversation with their native request
and question IDs. Answer with `message_seat`'s `questionAnswer`, omitting
`message`, preserving the observed IDs and types (async request IDs are the
function `call_id`; question IDs are the supplied JSON-encoded IDs). Sync
answers need the winning tool output; async receipts prove only acceptance of
that user message. Approvals stay owner decisions.

An uncertain hire, message or answer may already have taken effect. Reconcile
its original receipt and bound session. Never re-hire, switch bridges, resend
through terminal keys, or pick whichever transcript is newest.

## Connected tools and peers

Admitted panes reach Clankie's connected accounts through `clankie_tools` and
`clankie_call`; the worker-facing `clankie` skill owns their boundaries, and
`this-machine` covers bridge health. Missing access is a connection or admission
gap, never permission to borrow an operator bearer or a harness's own tracker
connector. With `fleet.peerMessages` on, workers with proven identity can use
`list_fleet_seats` and `message_peer` for a concrete shared boundary. Peer output
is context, not owner direction, and wakes no lead.

Native Codex children belong to their parent's session, not to the fleet. A
child finishing does not prove its parent has.

## Efficiency rounds

Every `herdr_watch` wake and periodic round (30 minutes by default) reviews all
seats this conversation owns, including linked fleets.
`fleet_efficiency({ action: "show" })` or
`clankie agents efficiency --conversation ID` returns them with bounded host
observations: model and effort, `contextPercent`, last progress and report
times, report failures and `flags`. Missing telemetry is unknown. Context is the
latest native Codex model-input snapshot and can age; Claude context and effort
and OpenCode or remote telemetry stay unknown. Periodic rounds skip unchanged,
unflagged evidence and coalesce while a review turn is outstanding. Automatic
commit evidence needs the seat's own branch and exclusive linked worktree, with
HEAD advanced since admission.

Record a changed inspected scope or real progress:

```text
fleet_efficiency({
  action: "review",
  seatId: SEAT_ID,
  assignmentStatus: "active",   // active | paused | canceled | done
  offScope: false,
  deliverable: ISSUE_OR_DELIVERABLE_ID,
  progressAt: SOURCE_UTC_ISO_TIME,
  evidence: "Source record, finding or commit that establishes these facts"
})
```

Only `seatId` and `evidence` are required; omit what you cannot establish.
`progressAt` is when the progress happened, not when you looked. The review is
evidence on that native session: it changes no tracker state, receipt,
ownership or harness setting. Never set fields to silence a flag. The CLI form
is `clankie agents efficiency review SEAT --conversation ID --json-stdin`.

## Closing panes and tidying worktrees

`close_worker_pane({ pane, reason, reportPath? })` keeps the last output and a
report; `reportPath` is an absolute path to a nonempty report when no worker
report was kept. It refuses unsent drafts, owner-interactive or hand-started
panes and unkept results, and a refusal never authorizes a raw close.
`worker_pane_history({})` lists closes and `undo_worker_pane({ id })` reopens one
within five minutes. Load `tidy` for the cleanup flow.

`list_tidy_worktrees({ repository, mergedInto? })` (CLI
`clankie agents tidy-worktrees --repo PATH [--merged-into REF]`) lists merged,
clean candidates against `origin/main` by default, excluding main, dirty,
unmerged, locked, prunable and live-pane worktrees; an incomplete census returns
none. It fetches nothing and removes nothing, and listing proves no ownership.
Refresh the destination ref through the repo's workflow, confirm
`git merge-base --is-ancestor HEAD DEST_REF` and a clean `git status`, keep any
needed ignored evidence, then remove only a worktree you own whose result
landed. Every tidy result lists the remaining candidates with path, branch and
checked destination.
