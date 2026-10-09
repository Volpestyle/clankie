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
`/agents roles`, where `auto` harness, model or effort means no preference.
With no preference, pass a model or effort only when you choose one for that
task.

An unset harness is yours to choose per hire (status shows it as "no
preference"). Guidance from the owner, not a rule: prefer Claude for visual and
creative work; otherwise pick the best fit for the job and consider each
harness's `allocation` in `worker_accounts`. Pass the harness you chose. If
you pass none and no role or fleet names one, the hire falls back to the
machine's usable, unheld accounts: the only harness that has one, else the one
whose best account is not on pace to run out before its reset, else Codex only
when its best account has more of its tightest window left than Claude's. No
usable account refuses before any pane opens. A resume keeps its saved
session's harness.

With the harness chosen and no account named, the hire takes that harness's
rank-1 account in `allocation`: the one with the most spare capacity per day
(plan size × what is left ÷ days to reset, less its current pace). The hire
result's `accountChoice.reason` says which and why. A "Usage warning" wake
means an account is on pace to run out well before its reset: steer new hires
to the account it names and hand long seats off at their next checkpoint;
nothing was moved for you.

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
share it). Omit placement to fill named 2x2 worker tabs, at most four per tab,
before opening the next numbered tab. Positions are top-left, top-right,
bottom-left, bottom-right. The group defaults to the project's display name or deliverable
(and the repository when neither is supplied; unnamed non-Git directories use `Workers`). `pipeline` overrides its name,
for example `VUH-1869 authors`. Explicit `new-tab` keeps a solo `Name · role`
tab; explicit `split` requires a pipeline. Verified repo/group/grid metadata
keeps hires out of unmarked or older lanes. Prepared native hires move only
their newly created initial-command pane into the group. Never rearrange
existing panes or substitute the lead's or focused pane.

Sub-leads without `hire_agent` use the exact [worker grid commands](../../clankie/reference/worker-layout.md).
The old generated `lead/reference/operations.md` is now this canonical source;
plugin builds copy the shipped skills rather than maintaining a second guide.

Accounts: `worker_accounts` (omit `fleet` for this Mac, or pass one such as
`pc`) reads that machine's Claude profiles and Codex accounts now: identity,
plan and tier, each account's usage windows, worker plugin per Claude profile,
owner holds, `usable` or the reason with its fix (including a Claude profile
whose first-run setup is unfinished), and `allocation`: each harness's accounts
ranked for the next hire with a one-line reason and any projected run-out. Choose the
harness and `account` per hire from it and the owner's fleet notes; nothing pins
one, and no harness is assumed. A linked machine's labels are its own: `default` plus each
`~/.claude-<label>` / `~/.codex-<label>`. An explicit label is used exactly or
refused with the machine, profile and fix, never swapped; omitted (or `auto`),
Clankie takes the usable, unheld account ranked first in `allocation` and
names what it skipped. Exhausted, signed-out or refused sign-ins are skipped. Relay a refusal's
fix to the owner rather than signing anything in yourself.

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

Hired Codex and Claude questions reach the hiring conversation with their native request
and question IDs. Answer with `message_seat`'s `questionAnswer`, omitting
`message`, preserving the observed IDs and types (async request IDs are the
function `call_id`; question IDs are the supplied JSON-encoded IDs). Sync
answers need the winning tool output; async receipts prove only acceptance of
that user message.

For local Codex async questions, losing Clankie's launch controller does not
require a re-hire. The question channel reconnects to the dedicated Unix socket
observed on the same native pane and verifies that the original thread is still
loaded. It can read and answer the exact question through this connection;
ordinary messages, completion watches and native synchronous requests retain
their existing controller requirements. It never resumes stored history or
selects an account daemon. An uncertain async answer keeps its durable claim
across restart: inspect the original worker rather than sending it again.

Claude `AskUserQuestion` and permission prompts use live plugin command hooks.
Their request IDs bind the exact pane, session, tool invocation and hook event;
answers return as hook JSON, never terminal keystrokes. Answer all question IDs
once, preserving their observed options. Expired, closed or resolved questions
refuse later answers. A bridge error falls back to the harness's own prompt;
do not retry a question through another transport.

Read `clankie fleet status` in the current verified workspace. Its generated
Worker gates summary resolves `everydayWork`, `leavesMac`, `hardToUndo`, and
`moneyAndAccounts` globally and per project. `allow` delegates ordinary work
within existing authority; `lead` asks you to decide; `owner` reserves the choice
for James. Money/accounts always belong to the owner. Push and release reuse
their existing settings. Hands-off, Balanced and Careful presets change only
the category leaves; explicit assignment limits retain precedence.

Native permissions are a partial projection: hired Claude starts in auto mode
without blanket ask rules. Managed denies, tracker denies and permission hooks
still apply; Bash is never blanket-allowed. Unclassified permission prompts
stay owner-only. Local Codex keeps its sandbox with on-request approvals; only
its own `clankie` bridge tools run without a native prompt. Native custom rules
remain harness-owned. Neither the preset name nor a native allow rule proves
authority for accounts, money, credentials, evals, or hard-to-undo effects.

If the effective owner's `autonomy.fleet` gate reserves the decision, escalate
the observed question with Clankie's same `request_user_input` tool: supply
`workerQuestion: {seatId, requestId}`, a prompt, recommendation and `waitingOn`.
The host copies the real question and binds its native session and question IDs.
The owner's answer returns to the worker through that native channel and wakes
your source conversation with the outcome. Never retype or resend it yourself.
For your own asks use `purpose: decision` with options and recommendation,
`approval` with the owner-reserved gate, or `owner_action` with exact steps.
Delegated gates do not raise an owner ask; settings never grant credentials.
Several independent asks can stay open in one conversation. Keep each pending
or uncertain ask and reconcile its original ID. Answer or cancel only that ID;
a sibling answer can change the conversation revision, so refresh on conflict
without substituting another ask. Capacity refusal does not evict pending asks
or uncertain claims.

An uncertain hire, message or answer may already have taken effect. Reconcile
its original receipt and bound session. Never re-hire, switch bridges, resend
through terminal keys, or pick whichever transcript is newest.

When a result is worth the owner's attention, deliberately call `mail_owner_update`
with a title, short body and optional issue `{tracker, key, url}`, worker `seatId`,
links or already published media URLs. It mails news, never an answer or a gate:
nothing waits, and owner read/dismiss does not wake you. No event is automatically
mailed. The host binds your source; navigation hints grant no authority. Keep the
returned update ID after uncertainty; never resend under a new tool call.
MCP carries a unique publication UUID per call in
`_meta["clankie/owner-update"].publicationId`. Exact transport retries retain
that identity; a reconnect or identical draft does not identify a prior call.
Owner API/CLI/TUI list, read and dismiss by update ID. Active updates survive
retention; capacity refuses instead of evicting them. Asks also accept the optional
`issue` reference so the mailbox can walk to the work item.

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

`close_worker_pane({ pane, reason, reportPath?, unlandedReason? })` keeps the
last output and a report; `reportPath` is an absolute path to a nonempty report
when no worker report was kept. It refuses unsent drafts, owner-interactive or
hand-started panes, unkept results, and `unlanded_work`: the worker's start or
foreground worktree has commits not on `origin/main` by content
(`git cherry`) or uncommitted files, or is on a remote fleet and unreadable.
Land the work or hand it to its owner; pass `unlandedReason` only when leaving
it is deliberate, and it stays with the close record. The app's and TUI's
close (`close_seat`) holds the same way. A refusal never authorizes a raw close.
`worker_pane_history({})` lists closes and `undo_worker_pane({ id })` reopens one
within five minutes. Load `tidy` for the cleanup flow.

`list_tidy_worktrees({ repository, mergedInto? })` (CLI
`clankie agents tidy-worktrees --repo PATH [--merged-into REF]`) lists landed,
clean candidates against `origin/main` by default (merged, by content, or a
decided drop), excluding main, dirty, unlanded, locked, prunable and live-pane
worktrees; an incomplete census returns none. Retained unmerged or dirty trees
carry their unlanded and uncommitted counts and a classification; judge an
`undecided` one with `decide_tidy_worktree({ repository, path, decision:
worth_landing|safe_to_drop, reason })` (CLI `clankie checkouts decide`). It fetches nothing and removes nothing, and listing proves no ownership.
Refresh the destination ref through the repo's workflow, confirm
`git merge-base --is-ancestor HEAD DEST_REF` and a clean `git status`, keep any
needed ignored evidence, then remove only a worktree you own whose result
landed. Every tidy result lists the remaining candidates with path, branch and
checked destination.

## Unresolved Claude channel deliveries

A bridge ACK proves transport delivery, not model consumption. If
`message_seat` is unconfirmed, reconcile its exact native `messageId` (or MCP
dispatch UUID) with `reconcile_seat_call` in the original conversation. Read
`clankie seat-delivery list` for worker mailbox and native fences, including
fences retained after a mailbox ACK. Never resend to test receipt. The owner
can settle an unknowable original with `seat-delivery settle ID
abandoned-unknown --conversation ID`; it retains unknown evidence and frees
new intent without replaying the original.

## Claude permission questions

Use `message_seat` with the pending `questionAnswer` IDs from your existing
private authenticated lane. Only this worker's exact lead can answer routine,
scoped permissions within its current gates. Peers, rooms and Discord cannot
answer them. Owner-only calls go through the owner question inbox. Native channel
previews are sanitized and never establish routine authority: they stay owner-only.
Every permission decision has an audit actor and input hash; hook/channel pipe
writes are separate delivery evidence. Native channel application is unconfirmed,
so never retry a verdict or substitute an ordinary chat answer.

## Hand-started Claude channels

A hand-started Claude in a linked Herdr pane shows an exact-session restart
command when the worker channel flag is missing. Claude requires session opt-in;
plugin installation alone cannot enable a live channel. The owner can use the
shown `claude --resume UUID --channels plugin:clankie-worker@clankie` command.
Do not restart existing panes or substitute terminal input for messages. Explicit
development-plugin opt-in retains Claude's own confirmation and policy checks.

The roster's `inputCapabilities` lists current explicit `deliveryModes`, exact-task
`interrupt` support and Claude `nextTurnOnly`. Use the observed modes, not a
harness-name guess. Next-turn-only Claude supports Queue, never Steer; absence
of capabilities on an older service means unknown. Capabilities do not grant
authority, and a changed occupant or disconnected receiver can remove them.
