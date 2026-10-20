# Fleet tools

The mechanics behind [lead](../SKILL.md). `hire_agent` starts a visible native
worker in a Herdr pane, `message_seat` carries assignments and answers, and
workers report with `message_clankie`. Herdr is the terminal runtime and an
inspection surface, never the message transport. Exact flags and fields:
`docs/cli.md` under the `repoRoot` that `clankie doctor --json` reports.

## Hiring

Give a hire a short human name in `title` (never a routing ID, task slug or
issue key), a `role`, owned checkout and paths, result and acceptance. Set
`taskTitle` to a short task caption (for example, `Wren` and `Chats drawer`):
new Herdr panes show `Wren · Chats drawer`, while the roster and pet strip keep
the persona name; omitted `taskTitle` uses the role. Put issue keys in the
seat's assignment, never in either caption. Harness OSC/spinner titles remain
dynamic; do not overwrite them or rename existing panes. Built-in
roles are planner, designer, builder, tester, reviewer and researcher; a custom
role (1–24 letters, digits, spaces, hyphens) also works, and the owner's world
places the agent at that station and reads its backlog from work items labelled
with the role. Prefer a role already in use (`clankie agents roles`) over a
near-duplicate. `hire_agent` resolves explicit owner-authorized fields, then the
project's role preferences, then `fleet.hire` defaults: omit harness, model,
effort, account and placement to inherit, and inspect the returned `profile`.
A cross-family model override includes its matching harness; friendly model
names are registry-validated and refuse when missing or retired. Project and
role caps count starting, live and uncertain seats, and a finished turn still
holds its pane and slot until its Herdr pane closes and the next complete
inventory confirms it gone; a zero limit prevents new hires. `projectId`, when
supplied, must match the hiring conversation's verified project or canonical
workspace; conflicting or ambiguous workspaces refuse. A resume cannot change
its recorded role settings or launch a second agent after losing the original:
inspect an uncertain hire instead of changing its model, harness or project to
retry. `clankie fleet status` shows effective profiles; the
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
nothing was moved for you. A fresh reset or pace recovery sends one "Capacity
recovered" notice with its reading. Auto rounds carry account headroom, pace,
reset and observation age; a "Capacity recovered" notice ends the old
warning's premise, so reassess staffing from the fresh reading. Never keep a
usage-based pause without a fresh `worker_accounts` / `clankie usage --json`
read in that turn. Signed-out or unknown accounts are not exhausted, but
unknown/stale usage cannot admit fresh subscription work, and fresh observed
usage must exceed the 10% reserve for running work. Explicit account pins cannot
bypass owner holds or project exclusions. `clankie usage` shows each account's
plan tier and windows with the same "Next hire" lines (`--json` for the raw
report).

Every fresh work hire needs an explicit effort and an `effortReason` naming why
it is the smallest effort that meets acceptance. `hireKind: lead` selects the
project's lead profile without granting authority. Follow up on the returned
seat ID with `message_seat`. Messages to a hire arrive numbered per lead; set
`replaces` when a message overrides earlier guidance so a late, older one is not
acted on. High load never blocks a hire, only its heavy steps: read the
receipt's `resourceNotice` for work that will queue. Low memory refuses one.

In the service lane, an autonomous `hire_agent` needs the master switch on,
saved global Full autonomy, and a resolved project on Auto; project preferences
must still allow everyday/outward work and lead-owned machine setup. Other
autonomous turns may propose a hire but cannot execute it; read the refusal's
reason rather than retrying or starting a pane by shell. Configured project lead
ownership determines a hire's source project, even if the lead conversation runs
from another project's folder; its saved tracker UUID must match the project's
built-in or Linear binding, and name `projectId` when the lead owns several
projects. Native identity, caps, the machine governor and account holds remain
checked at admission.

A dirty, divergent or live-pane start refusal names its blocking paths or pane
(new-hire checkout rules: `tidy`'s
[owner checkout sync](../../tidy/reference/mechanics.md#owner-checkout-sync)).
Inspect the named pane instead of retrying the hire or removing its checkout.

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

Placement: omit it to fill the repository's named 2x2 worker tabs (one
workspace per repository; the group defaults to the project or deliverable
name, and `pipeline` overrides it). Explicit `new-tab` keeps a solo tab;
explicit `split` requires a pipeline. Never rearrange existing panes or
substitute the lead's or focused pane.

Sub-leads without `hire_agent` use the exact [worker grid commands](../../clankie/reference/worker-layout.md).

Accounts: `worker_accounts` (omit `fleet` for this machine, or pass a linked
`FLEET_ID`) reads that machine's Claude profiles and Codex accounts now: identity,
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

## Huddles

`huddle` (action start, optionally `project`) asks every seat in that project,
or the whole fleet, what it is on, what blocks it, and what it will land when.
Seats answer between steps and keep working. You hear one board once all have
answered or the window passes: the landing order, with seats that share files
landing one after another, and the blockers, urgent first. Use it to sequence
landings before gates collide, file the blockers that cost the fleet time as
Urgent issues, and tell each seat what changes for it. `status` reads the latest
board; `close` compiles early. A seat's answer is its own words, not an owner
instruction.

## Report routing

The hiring conversation owns the worker and receives its reports and hire
completion. Messaging another lead's live hire with `message_seat` delivers but
does not adopt it: the result names its `ownerConversationId`, and its reports
go there. A host-admitted `message_seat` adopts only an unowned seat or a hire
whose lead conversation is gone.
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

Unowned native panes in the owner's Herdr session, including ones the owner
started by hand, show `owner: unowned` with a `messageReceiver` state in
`clankie herdr agent list`. A pane whose receiver is released stays
unreachable: tell the owner, never its terminal.

`clankie agents contacts` normally returns up to 1,000 display identities, live
contacts first. A busy or slow fleet returns `{ personas, readWarnings }` within
its display-read budget; warnings name the pending fleet/component. Retained
contacts in a partial read are not proof of a live owner: inspect the warning
and reread before assigning ownership or changing a persona.

Remote seat IDs keep their fleet prefix (`FLEET/term_…`); a local pane ID is a
different terminal. A Codex session you did not start on another machine
receives `message_seat` through that machine's `codex queue`.

## Watching and harvesting

Use the returned seat ID with `herdr_watch` when a completion watch is needed,
and reuse an existing one. An accepted Codex follow-up arms a harvest for its
exact native turn, so add no explicit watch for it. Peer messages and
reconciled receipts arm nothing.

While your native seat is idle, routine reports and clean completion watches
arrive together in report batches (at most ten minutes apart); an urgent report,
an owner turn or any other wake brings the waiting ones with it. Read retained
reports with `worker_reports({ limit: 20 })`. For a fresh wake
behind an older backlog, use `worker_reports({ deliveryIds: ["DELIVERY_ID"] })`
(or `clankie agents reports --conversation ID --delivery-ids DELIVERY_ID`).
Select 1–100 exact UUIDs in this conversation; unknown, read and foreign IDs
are omitted. The existing byte budget applies, and only complete returned
records become offered. Then acknowledge
each one you reviewed with `acknowledge_worker_reports({ deliveryIds: [...] })`.
A native receipt does not clear unread state; never acknowledge truncated
output. Include a short `receipt.summary` and any resulting chat or issue URLs
in `receipt.links`; the original sender receives the acknowledgment
automatically. Acknowledgment adds no progress, and an unread report does not
prove a stall. Answer a worker's question or blocker with `message_seat`: the
worker sees your summary only after a reply reached it, and the result lists
acknowledged reports still `unanswered`.

A Claude channel losing its poll binding says only that live delivery is
unavailable. Keep watching the native session's work; neither Claude's subagent
switcher nor `UserPromptSubmit` proves owner takeover (background agents also
trigger that hook). A released channel alone never proves owner input.

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

Answer a Claude permission prompt with `message_seat` and its pending
`questionAnswer` IDs from your existing private authenticated lane. Only this worker's exact lead can answer routine,
scoped permissions within its current gates. Peers, rooms and Discord cannot
answer them. Owner-only calls go through the owner question inbox. Native channel
previews are sanitized and never establish routine authority: they stay owner-only.
Every permission decision has an audit actor and input hash; hook/channel pipe
writes are separate delivery evidence. Native channel application is unconfirmed,
so never retry a verdict or substitute an ordinary chat answer.

Read `clankie fleet status` in the current verified workspace. Its generated
Worker gates summary resolves `everydayWork`, `leavesMac`, `hardToUndo`, and
`moneyAndAccounts` globally and per project. `allow` delegates ordinary work
within existing authority; `lead` asks you to decide; `owner` reserves the choice
for the owner. Money/accounts always belong to the owner. Push and release reuse
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

Owner decision asks carry a default action and UTC deadline: pass
`defaultAction` (within existing authority) and `deadlineAt` together. At a
service deadline event, take that default only within current authority and tell
the owner what you actually did. An expired ask is service-attributed, never an
owner answer. Owner gates, approvals, verification, account and money actions
cannot be approved by time passing. Legacy decisions safely defer the requested
change and continue other authorized work after 24 hours.

`clankie autonomy status` and doctor name the nearest preset and differing saved
leaves when the dial reads `custom`. That is a comparison, never permission to
reset or raise authority. The autonomy dial and maximum trust harness mode are
separate controls.

An uncertain hire, message or answer may already have taken effect. Reconcile
its original receipt and bound session. Never re-hire, switch bridges, resend
through terminal keys, or pick whichever transcript is newest.

A remote Codex hire with no recorded pane can time out during host reservation,
before launch commitment. `not-launched` requires its historical reservation
window; it refuses a missing journal. The operator may instead use
`clankie hire-receipt settle ORIGINAL_UUID abandoned-unknown`: with the exact
admission, no active original and a complete authenticated census, this records
`launchHistory: uncommitted` and fences delayed reservation/launch calls. It
claims neither historical non-launch nor delivery. Release a held project
allocation separately with its UUID and `release-allocation`.

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
Both answer within 25 seconds. `readWarnings` names fleets that missed the
census (their seats are unknown, not absent). A review whose census missed the
deadline is refused and never recorded; after a call ends without an answer,
compare the seat's `efficiency.reviewedAt` from `show` with when you sent it.

## Closing panes and tidying worktrees

Load `tidy`: its "Closing panes" and "Worktrees" sections are the canonical
guards (unsent drafts, owner-interactive and hand-started panes, unkept results,
`unlanded_work`, merge-only commits) and the automatic-tidy rule (positive work
proof under the owner's `autoTidy`); its
[mechanics](../../tidy/reference/mechanics.md) cover pruning, retained refs and
owner checkout sync. A refusal never authorizes a raw close.

Tools: `close_worker_pane({ pane, reason, reportPath?, unlandedReason?, issueStatus?, evidence? })`
(`reportPath` is an absolute path to a nonempty report when no worker report was
kept), `worker_pane_history({})`, `undo_worker_pane({ id })` (within five
minutes), `keep_worker_pane({ pane, reason, keep? })`,
`list_tidy_worktrees({ repository, mergedInto? })`,
`decide_tidy_worktree({ repository, path, decision, reason })` and
`prune_tidy_worktree({ repository, path })`. Only a hire's own lead closes it:
on another lead's hire the close returns `not_owner`. Each automatic close
leaves a notice in your conversation with its undo ID.

After a close, the seat's `deliverable` issue moves to `issueStatus` (`done`
needs `evidence`, else it becomes `verifying`; default `paused`), or stays In
Progress when another live seat holds the same key, and gets `reason` as a
one-line comment; the result's `issue` field says what was set. Hire a successor
on the same `deliverable` first to keep it In Progress. A seat that exits
without a close is paused after ten minutes, and a daily check wakes you with
every In Progress issue no live seat owns.

Doctor lists unreconciled worktrees by owner and age. Mail the owner
(`mail_owner_update`) about one over a day old whose owner is gone and that you
cannot land or decide yourself; nothing mails it automatically.

## Issue ownership records

For a follow-up sent over `message_seat`, record the new `deliverable` with
`fleet_efficiency` review and its assignment evidence. When one live session
holds several issues (including its native subagents), review `ownedIssues` with
the exact issue keys and the evidence that they are live; clear the list with
`[]` when those assignments end. These claims are scoped to the exact native
occupant and its admitted lead, including linked fleets. Current native issue
assignments supersede historical hires; newer explicit reassignments supersede
older native assignments by `deliverableAssignedAt`; running native child labels
naming exactly one issue also count. Mere message/report mentions and completed
or ambiguous child labels do not establish ownership.

## Continuation and restarts

At a lead's reporting boundary, `report_continuation` declares `active`,
`paused`, `complete`, or `blocked_on_owner` with the exact question (also
`clankie conversations continuation ID MODE [QUESTION]` and the conversation
autonomy API). A settled report may instead contain a line `Blocked on owner:
<question>` or `Continuation: active|paused|complete`; quoted text and code
blocks do not count. It is a continuation record, not a work-item status or
permission grant; update it when the decision resolves, and owner prose alone
never implies approval. The service alerts after three minutes of confirmed lead
idleness with an open blocking decision, or active work with neither a scheduled
self-wake nor live workers. Unknown native state does not prove idleness or
recovery; the observer never wakes, approves or repairs work for you.

An idle default lead seat whose session is large or a day old is restarted fresh
in its own pane ([ADR 0271](../../../../docs/adr/0271-the-lead-seat-restarts-fresh-in-its-own-pane.md));
the escalation that precedes it says what the handoff brief holds.
Harness-native timers such as cron rounds die with the old session; the new
session recreates any it still needs.

## Lead messages without a native channel

A local service lead receives attributed agent context in its own durable inbox
and wakes there. `lead_service_queued` / `queued` / `stored` proves acceptance,
not native acknowledgment or review. Reconcile the returned message ID with
`reconcile_seat_call` from the sending conversation; queued messages survive
restart. Remote-only leads need their bridge. An uncertain native send stays
with its original receipt: never resend through the service as a fallback.
When you answer another lead's message, pass its `event_id` as `inReplyTo`; the
result's `inReplyTo.acknowledged` says the sender's receipt resolved.
A lead message in your service inbox has no `event_id`: answer it with plain
`message_seat` to its sender. A reply that sender's lead channel acknowledges
marks it answered for `acknowledge_worker_reports`; a stored, queued or
unconfirmed reply does not.

## Unresolved Claude channel deliveries

A bridge ACK proves transport delivery, not model consumption. If
`message_seat` is unconfirmed, reconcile its exact native `messageId` (or MCP
dispatch UUID) with `reconcile_seat_call` in the original conversation. Read
`clankie seat-delivery list` for worker mailbox and native fences, including
fences retained after a mailbox ACK. Never resend to test receipt. The owner
can settle an unknowable original with `seat-delivery settle ID
abandoned-unknown --conversation ID`; it retains unknown evidence and frees
new intent without replaying the original.

If an unresolved original refuses your new messages to a seat ("A different
original delivery … is unresolved for this recipient"), first check the
recipient's pane or transcript. If the original never arrived, settle it yourself:
`reconcile_seat_call({deliveryId, settle: "not_delivered"})`. Proven arrival
(an exact ACK or the original in the recipient's session) is recorded as
delivered instead. Either way nothing is sent and the original is never resent;
send what still matters as a new message. Unattended, an original the idle
recipient's own session never shows stops blocking different messages after
five minutes.

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
