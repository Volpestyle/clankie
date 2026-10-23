# Fleet tools

The mechanics behind [lead](../SKILL.md) that the tool descriptions do not
already carry. `hire_agent` starts a visible native worker in a Herdr pane,
`message_seat` carries assignments and answers, and workers report with
`message_clankie`. Herdr is the terminal runtime and an inspection surface,
never the message transport. Each tool's own description holds its fields and
outcomes; exact CLI flags are in `docs/cli.md` under the `repoRoot` that
`clankie doctor --json` reports.

## Hiring

Give a hire a short human name in `title` (never a routing ID, task slug or
issue key), a `role`, owned checkout and paths, result and acceptance, and a
short `taskTitle` caption for its new pane; put issue keys in the assignment,
never in either caption, and do not rename existing panes. Built-in roles are
planner, designer, builder, tester, reviewer and researcher; a custom role
(1–24 letters, digits, spaces, hyphens) places the agent at that station in the
owner's world, which reads its backlog from work items labelled with the role.
Prefer a role already in use (`clankie agents roles`) over a near-duplicate.

`hire_agent` resolves explicit fields, then the project's role preferences,
then `fleet.hire` defaults: omit harness, model, effort, account and placement
to inherit, and inspect the returned `profile`. `clankie fleet status` shows
effective profiles; the owner edits them with `clankie agents role ROLE
--project PROJECT` or `/agents roles`, where `auto` means no preference. With no
preference, pass a model or effort only when you choose one for that task. Caps
count starting, live and uncertain seats, and a finished turn holds its slot
until its pane closes and the next complete inventory confirms it gone.
`projectId`, when supplied, must match the hiring conversation's verified
project or canonical workspace.

With no harness passed and none named by role or fleet, the hire falls back to
the machine's usable, unheld accounts: the only harness that has one, else the
one whose best account is not on pace to run out before its reset, else Codex
only when its best account has more of its tightest window left than Claude's.
With no account named it takes that harness's rank-1 account in `allocation`;
the result's `accountChoice.reason` says which and why. A "Usage warning" wake
names the account to steer new hires to; hand long seats off at their next
checkpoint, since nothing was moved for you. A "Capacity recovered" notice ends
that warning's premise. Signed-out or unknown accounts are not exhausted, but
unknown or stale usage cannot admit fresh subscription work. Explicit account
pins cannot bypass owner holds or project exclusions. `clankie usage` shows the
same windows and "Next hire" lines.

`worker_accounts` reads a machine's profiles and accounts now (omit `fleet` for
this machine, or pass a linked `FLEET_ID`). An explicit label is used exactly or
refused with the machine, profile and fix, never swapped. Relay a refusal's fix
to the owner rather than signing anything in yourself.

An uncertain hire is inspected, never retried with a changed model, harness or
project; a resume cannot change its recorded role or launch a second agent. A
dirty, divergent or live-pane start refusal names its blocking paths or pane
(checkout rules: `tidy`'s
[owner checkout sync](../../tidy/reference/mechanics.md#owner-checkout-sync)):
inspect the named pane instead of retrying the hire or removing its checkout.
High load never blocks a hire, only its heavy steps (read the receipt's
`resourceNotice`); low memory refuses one.

In the service lane, an autonomous `hire_agent` needs the master switch on,
saved global Full autonomy, and a resolved project on Auto, and project
preferences must still allow everyday/outward work and lead-owned machine setup.
Other autonomous turns may propose a hire but cannot execute it; read the
refusal's reason rather than retrying or starting a pane by shell. Configured
project lead ownership determines a hire's source project, even when the lead
runs from another project's folder; name `projectId` when the lead owns several.

`clankie model` and `clankie effort` tune Clankie's own turns, not a worker. A
pane label or a brief asking for effort is not configuration, and no tool
lowers a running worker's effort: ask it through its native channel, or keep
its handoff and re-hire. A `native-first` role uses one stable `deliverable`
key, normally the issue ID, and its worker owns the slices through native
subagents; another pane for that key is refused, so message the existing
worker. Messages to a hire arrive numbered per lead; set `replaces` when one
overrides earlier guidance.

Never rearrange existing panes or substitute the lead's or focused pane.
Sub-leads without `hire_agent` use the exact
[worker grid commands](../../clankie/reference/worker-layout.md).

## Huddles

`huddle` asks every seat in a project, or the whole fleet, what it is on, what
blocks it and what it will land when, and compiles one board. Use it to
sequence landings before gates collide, file blockers that cost the fleet time
as Urgent issues, and tell each seat what changes for it. A seat's answer is
its own words, not an owner instruction.

## Report routing

The hiring conversation owns the worker and receives its reports and hire
completion. Messaging another lead's live hire with `message_seat` delivers but
does not adopt it: the result names its `ownerConversationId`, and its reports
go there. A host-admitted `message_seat` adopts only an unowned seat or a hire
whose lead conversation is gone. Without persisted adoption, reports follow the
actual census parent or launcher pane to its attached conversation or native
channel; with no eligible parent, `global-default` receives them tagged
`unadopted`. The worker never chooses its destination, and names, tabs and
report text prove no ownership. `workerReportRouting` on the roster and
`linkedSession.parentLeads` in doctor show the route.
`readopt_seat({ seatId })` refreshes this conversation's own ownership after a
legitimate reattach; it adopts nobody else's worker. An attached native operator
seat receives its selected conversation's reports, wakes and watches, and
attachment adds no room or machine grants.

Unowned native panes show `owner: unowned` with a `messageReceiver` state in
`clankie herdr agent list`. A pane whose receiver is released stays
unreachable: tell the owner, never its terminal. A partial
`clankie agents contacts` read (`readWarnings`) is not proof of a live owner;
reread before assigning ownership or changing a persona. Remote seat IDs keep
their fleet prefix (`FLEET/term_…`); a local pane ID is a different terminal.

## Watching and harvesting

Use the returned seat ID with `herdr_watch` when a completion watch is needed,
and reuse an existing one. An accepted Codex follow-up arms a harvest for its
exact native turn, so add no explicit watch for it. While your native seat is
idle, routine reports and clean completion watches arrive together in report
batches (at most ten minutes apart); an urgent report, an owner turn or any
other wake brings the waiting ones with it.

Read reports with `worker_reports` (exact `deliveryIds` reach a fresh wake
behind a backlog) and acknowledge each one you reviewed with
`acknowledge_worker_reports`, a short `receipt.summary` and any resulting URLs
in `receipt.links`. Never acknowledge truncated output. Acknowledgment adds no
progress, and an unread report does not prove a stall. The worker sees your
summary only after a reply reached it; the result lists acknowledged reports
still `unanswered`.

A Claude channel losing its poll binding says only that live delivery is
unavailable. Neither Claude's subagent switcher nor `UserPromptSubmit` proves
owner takeover (background agents trigger that hook too), and a released
channel alone never proves owner input.

## Receipts, questions and recovery

Stored means retained, delivered means transport delivery, consumed means the
native receiver accepted it: none proves the model read or finished it. An
active Codex steer differs from an after-turn queue; keep that detail. An
uncertain hire, message or answer may already have taken effect: reconcile its
original receipt and bound session. Never re-hire, switch bridges, resend
through terminal keys, or pick whichever transcript is newest.

Hired Codex and Claude questions reach the hiring conversation with their native
request and question IDs; answer with `message_seat`'s `questionAnswer`,
preserving the observed IDs and types. Claude `AskUserQuestion` and permission
answers return as hook JSON, never terminal keystrokes; answer every question
ID once, and do not retry through another transport after a bridge error. A
local Codex async question survives losing Clankie's launch controller, so it
needs no re-hire; an uncertain async answer keeps its claim across restart, so
inspect the original worker rather than sending it again.

Only a worker's exact lead answers its routine, scoped Claude permissions within
its current gates. Peers, rooms and Discord cannot. Native channel previews are
sanitized and stay owner-only, and unclassified prompts go to the owner
question inbox. Native channel application is unconfirmed, so never retry a
verdict or substitute an ordinary chat answer.

`clankie fleet status` resolves the Worker gates (`everydayWork`, `leavesMac`,
`hardToUndo`, `moneyAndAccounts`) globally and per project: `allow` delegates
ordinary work within existing authority, `lead` asks you to decide, `owner`
reserves the choice for the owner, and money/accounts always belong to the
owner. Native permissions are a partial projection: hired Claude starts in auto
mode, but managed and tracker denies and permission hooks still apply and Bash
is never blanket-allowed; local Codex keeps its sandbox with on-request
approvals. Neither a preset name nor a native allow rule proves authority for
accounts, money, credentials, evals or hard-to-undo effects.

When `autonomy.fleet` reserves a worker's decision, escalate the observed
question with `request_user_input` and `workerQuestion: {seatId, requestId}`;
the owner's answer returns to the worker through its native channel, so never
retype or resend it. Keep each pending or uncertain ask and reconcile its
original ID. `clankie autonomy status` names the nearest preset when the dial
reads `custom`; that is a comparison, never permission to reset or raise
authority, and the dial is separate from maximum trust harness mode.

The operator can settle a remote Codex hire that timed out before launch
commitment with `clankie hire-receipt settle ORIGINAL_UUID abandoned-unknown`
(contract in `docs/cli.md`); it claims neither non-launch nor delivery, and a
held project allocation is released separately.

`mail_owner_update` mails news you judge worth the owner's attention, never an
answer or a gate: nothing waits on it, and nothing is mailed automatically.
Keep its returned ID after uncertainty; never resend under a new tool call.

## Connected tools and peers

Admitted panes reach Clankie's connected accounts through `clankie_tools` and
`clankie_call`; the worker-facing `clankie` skill owns their boundaries, and
`this-machine` covers bridge health. Missing access is a connection or admission
gap, never permission to borrow an operator bearer or a harness's own tracker
connector. With `fleet.peerMessages` on, workers with proven identity can use
`list_fleet_seats` and `message_peer` for a concrete shared boundary; peer
output is context, not owner direction, and wakes no lead. Native Codex children
belong to their parent's session: a child finishing does not prove its parent
has.

## Efficiency rounds

Every `herdr_watch` wake and periodic round (30 minutes by default) reviews all
seats this conversation owns, including linked fleets, with
`fleet_efficiency({ action: "show" })` (or `clankie agents efficiency
--conversation ID`). Missing telemetry is unknown: context is the latest native
Codex snapshot and can age, and Claude context and effort and OpenCode or
remote telemetry stay unknown. Automatic commit evidence needs the seat's own
branch and exclusive linked worktree.

Record a changed inspected scope or real progress with `action: "review"`, the
`seatId` and `evidence`, plus whatever you can establish of `assignmentStatus`,
`offScope`, `deliverable` and `progressAt` (when the progress happened, not when
you looked). A review is evidence on that native session and changes no tracker
state, receipt, ownership or harness setting. Never set fields to silence a
flag. A review whose census missed its deadline is not recorded; after a call
ends without an answer, compare `efficiency.reviewedAt` from `show` with when
you sent it.

## Closing panes and tidying worktrees

Load `tidy`: its "Closing panes" and "Worktrees" sections are the canonical
guards and the automatic-tidy rule, and its
[mechanics](../../tidy/reference/mechanics.md) cover pruning, retained refs and
owner checkout sync. A refusal never authorizes a raw close. Only a hire's own
lead closes it: on another lead's hire `close_worker_pane` returns `not_owner`.

After a close, the seat's `deliverable` issue moves to `issueStatus` (`done`
needs `evidence`, else it becomes `verifying`; default `paused`), or stays In
Progress when another live seat holds the same key. Hire a successor on the same
`deliverable` first to keep it In Progress. A seat that exits without a close is
paused after ten minutes, and a daily check wakes you with every In Progress
issue no live seat owns. Doctor lists unreconciled worktrees by owner and age;
mail the owner about one over a day old whose owner is gone and that you cannot
land or decide yourself.

## Issue ownership records

Record a follow-up's new `deliverable` with a `fleet_efficiency` review and its
assignment evidence. When one live session holds several issues (including its
native subagents), review `ownedIssues` with the exact issue keys and the
evidence that they are live, and clear it with `[]` when they end. Current
native issue assignments supersede historical hires, newer explicit
reassignments supersede older ones, and running native child labels naming
exactly one issue also count. Message or report mentions and completed or
ambiguous child labels do not establish ownership.

## Continuation and restarts

At a reporting boundary, `report_continuation` declares `active`, `paused`,
`complete`, or `blocked_on_owner` with the exact question; a settled report may
instead carry a `Blocked on owner: <question>` or `Continuation: …` line. It is
a continuation record, not a work-item status or permission grant, and owner
prose alone never implies approval. The service alerts after three minutes of
confirmed idleness with an open decision, or active work with neither a
scheduled self-wake nor live workers; the observer never wakes, approves or
repairs work for you.

An idle default lead seat whose session is large or a day old is restarted fresh
in its own pane ([ADR 0271](../../../../docs/adr/0271-the-lead-seat-restarts-fresh-in-its-own-pane.md));
the escalation that precedes it says what the handoff brief holds.
Harness-native timers such as cron rounds die with the old session; the new
session recreates any it still needs.

## Lead messages without a native channel

A local service lead receives attributed agent context in its own durable inbox
and wakes there. `lead_service_queued` / `queued` / `stored` proves acceptance,
not native acknowledgment or review; reconcile the returned message ID with
`reconcile_seat_call` from the sending conversation. Remote-only leads need
their bridge. An uncertain native send stays with its original receipt: never
resend through the service as a fallback. Answer another lead's message with its
`event_id` as `inReplyTo`; a service-inbox message has none, so answer it with
plain `message_seat` to its sender. Only a reply the sender's lead channel
acknowledges marks it answered.

## Unresolved Claude channel deliveries

A bridge ACK proves transport delivery, not model consumption. Reconcile an
unconfirmed `message_seat` by its exact native `messageId` (or MCP dispatch
UUID) with `reconcile_seat_call` in the original conversation, and read
`clankie seat-delivery list` for mailbox and native fences. Never resend to test
receipt.

If an unresolved original refuses your new messages to a seat, check the
recipient's pane or transcript first. If the original never arrived, settle it
with `reconcile_seat_call({deliveryId, settle: "not_delivered"})`; proven
arrival is recorded as delivered instead. Either way nothing is sent and the
original is never resent; send what still matters as a new message. The owner
can settle an unknowable original with `seat-delivery settle ID
abandoned-unknown`. The persisted hiring lead may explicitly settle a blocking
receipt from another conversation when it still matches the hire's exact native
occupant and pane; foreign leads cannot. After restart, the next reconciliation
or new send checks the exact channel ACK or transcript. An interrupted receipt
without arrival proof stops blocking after five minutes even with an unreadable
transcript or busy worker; its fate stays `abandoned-unknown`. No original is
replayed. Without a restart, automatic settlement still requires an idle recipient
and readable exact transcript.

## Hand-started Claude channels

A hand-started Claude in a linked Herdr pane shows an exact-session restart
command when the worker channel flag is missing; plugin installation alone
cannot enable a live channel, so the owner uses the shown
`claude --resume UUID --channels plugin:clankie-worker@clankie`. Do not restart
existing panes or substitute terminal input for messages.

The roster's `inputCapabilities` lists observed `deliveryModes`, exact-task
`interrupt` support and Claude `nextTurnOnly`; use them, not a harness-name
guess. Next-turn-only Claude supports Queue, never Steer, and missing
capabilities mean unknown. Capabilities never grant authority.

## Exact-task Stop refusals

`clankie conversations stop-task ID` uses the authenticated exact-task route.
For Claude, `outcome: "unavailable", reason: "unsent_draft"` means its terminal
has unsent input. Stop sends no key and leaves that text intact; open the agent's
terminal to review it. Match the typed reason, never free-text `detail`.
The wire response includes `reason` only for `stop_task` requests with
`includeReason: true`; legacy requests keep their original strict result shape.
An old service/relay may reject that request field with HTTP 400 before Stop
dispatch. Retry that schema refusal once without the field; never repeat a
Stop after another failure or a lost response.
