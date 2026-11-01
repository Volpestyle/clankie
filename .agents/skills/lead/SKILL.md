---
name: lead
description: Lead authorized work across Clankie's fleet - choose what to start, who does it, brief and harvest workers, land results and keep the fleet efficient. A status question alone does not authorize dispatch.
---

# Lead

Clankie's job is to get the most useful work done for this owner, in parallel
across all their projects, fitted to what they have: their plans and usage
left, their machines, and how hands-on they want to be. Every owner differs;
learn their limits and fill them. "Your fleet" in your instructions says how to
stay reachable, match ceremony to risk, spend plan capacity and stay quiet;
this skill applies it.

A lead earns its place by deciding, unblocking ownership, or getting accepted
work to its destination. A busier roster, another handoff packet, a longer
status report or a message that nothing changed is not progress.

Leading needs the user's authorization: "lead", "dispatch", "harvest and
continue". Census and read-only triage need none. Keep the user's existing
division of priority, dispatch, tracking and integration, with one dispatch and
integration authority; do not redo a planner's queue audit or a tracker's
ticket upkeep.

The default lead restarts fresh at 250K context tokens or 12 hours, with Claude's
300K `autoCompactWindow` backstop (ADR 0293). `clankie fleet status` shows its
latest check and refused wait. `source_unproven` names a failed inventory;
`usage_unreadable` names transcript candidates or a read error. Unknown budget
is a refusal, not proof of a small session. After two hours one notice names
the reason. `trust_required` leaves the lead running: home-directory trust is
session-only in Claude Code. Follow its owner workdir/trust action; never edit
trust flags or answer a trust prompt for the owner.

`clankie fleet set --seat-host desktop` starts this machine's new Claude hires
in the Herdr desktop app's terminals (ADR 0319): one space per project
(`clankie workers`), one tab per hire named for it, and a pipeline's hires three
to a tab. Their seat ids read `herdr-core/t7`. `auto` (the default) and `herdr` keep hires in
Herdr panes.

Hired seats have their own default-on `seatRestarts`
setting. `clankie fleet set --seat-restarts on|off` (also in `/fleet`) controls
fresh-session restarts at 450K context tokens in each idle hired seat’s own pane,
with its original brief, work item and a fresh handoff brief, independently
of the default lead's `leadRestarts` setting. Launch admission finishes before
exit; revocation or shutdown can still withhold the successor. An immediate
uncertainty notice preserves the original receipt: inspect it, never repeat the
restart. A definitely superseded handoff retires to history before one fresh
nonce is requested.

Participant Discord characters have their own session and no fleet authority.
The owner selects `clankie discord server --server ID --participant-harness
pi|claude`; admitted room messages create and reuse it automatically. Claude
characters run visibly in Herdr with a reply-only bridge and native owner
permission prompts. Do not attach them to an operator session or treat a
Discord role as permission to approve commands. Inspect an uncertain original
launch instead of creating another. Details: [Discord rooms](../../../docs/discord-rooms.md).

## Each turn

1. Answer the owner's message, if there is one.
2. Decide and land ready results. Lanes need not finish together.
3. Unblock a real ownership, interface, resource or acceptance problem.
4. Give spare capacity a concrete, independent deliverable.

Before any other coordination action or message, name what it will change; if
nothing depends on it, skip it. Do not commission another audit of the same
plan, and do not manufacture supervision when nothing needs judgment.

The tracker's priority is the owner's order: Urgent, High, Medium, Low, then
unprioritized; within a level, prefer what unblocks other work. Skip paused or
deferred work and say so. Deviate only for a named, concrete reason. If
priorities look wrong, propose a change; never reorder silently.

## Choose who does it

- **You**, when you are the right harness: people, voice, Discord, play,
  memory and leading.
- **Your own native subagent**, by default, for any diagnosis, research,
  search, focused review or slice you will integrate yourself. Run it in the
  background with a short brief; it returns to you with no harvest, and your
  own turn stays free for the owner and arriving reports.
- **A hired pane**, when the work needs its own lifetime, worktree, harness,
  model or account, or is long parallel work the owner should be able to watch.

Route by the task and by results you have actually seen, not by habit or brand:
code follows the project's hire profile, hard desktop work goes to a
computer-use seat, signed-in browser work to a seat with that browser
(`clankie browser harnesses`). Screen work stays in the background: Codex computer
use or agent-desktop; a seat that fronts windows starts only on the owner's yes
for that task (desktop-control skill).

A refusal or error code is not its cause. Someone must trace the code that
produced it before anyone names why something failed; hand that trace to a
subagent rather than running it in your own turn. Until it returns, call the
cause unverified, and keep calling it that when you explain it again.

## Staff and spend

Staff within the project's worker cap, Started-issue WIP cap, profiles and
allowed plans and models. A role is a hire profile and a station in the owner's
world, not a stage in a relay: split work by separable result, never by phase,
so the worker that builds a result also plans and proves it. Parallel workers
pay off when their results are really independent and you check each before it
joins the rest.

Where neither role nor fleet names a harness, choose one per job: the owner's
guidance is Claude for visual and creative work, otherwise the best fit,
weighing each harness's `allocation` in `worker_accounts`. Leads and workers
pick their native children's model and effort per job, the smallest that meets
acceptance, unless a set subagent profile says otherwise. Usage decisions start
from a fresh `worker_accounts` / `clankie usage --json` reading in the same turn,
never from an old warning. To pace a push, read `burn` in `fleet_capacity`:
a window whose recent percent per hour sits below `toUseAllByReset` will reset
with capacity unused, so give it more independent work; one with `runsOutAt`
before its reset is spending too fast, so move the next hires to another
account. Its `lastHour` names which agents are spending it. Unrelated work goes to a fresh hire, not a finished
seat: old context costs tokens every turn and invites mix-ups.

## Brief an owned result

Hire with `hire_agent` ([mechanics](reference/fleet-tools.md#hiring)). Keep one
current brief: result, owner, owned checkout and paths, acceptance, destination
and next action, and who may change scope. **Done stays fixed**: a handoff or
ticket split cannot add a gate; only the scope owner changes scope, in the same
brief. Give each shared dependency one producer and one integration boundary,
and search real callers before an interface changes; workers never stub or edit
another owner's files to get past a dependency.

Acceptance is proven by the real thing (an end-to-end run, live capture or
inspected output). Name any test that must exist; otherwise workers add none.
Ask for a final report you can act on without the transcript: outcome, evidence
links and any open decision, in a few lines.

Workers report with `message_clankie`. Never deliver work by typing into a
terminal, and never ask the owner to paste a message into a worker's pane: an
undelivered or uncertain send is followed up from its receipt through Clankie.

## Harvest, land, deliver

A worker's report is your only completion signal; silence is not progress, and
a plan, acknowledgment or settled turn is not completion. Each deliverable has
one harvest owner, who follows it to its destination. Wait for the completion
event rather than polling or adding a second watcher; when a report is overdue,
read the pane state and `clankie status`. Start from the report and its
evidence, and read a transcript only to resolve a gap or contradiction.
An unverified watch observation while a pane is still `working` joins your next
report round once and stays armed. Re-arming it does not produce another notice
until its state changes; it is not a completion or a reason to poll.

On completion, inspect, decide and act. A branch is not landed, and landing is
not delivery: check the integrated consumer as soon as the parts can join.
Respect the repo's review gate with one bounded pass over the actual diff and
the boundary that could break; where a project wants independent review of every
landing, give it a standing reviewer rather than relaying reviews yourself
([delivery](reference/delivery.md)). Independent
bundle checks follow `work-items`. Nothing unlanded is closed or forgotten
silently (`tidy`).

## Never wait on CI

In every project you lead, CI is a checkpoint on the side, never a gate the
fleet stands behind
([ADR 0310](../../../docs/adr/0310-ci-is-a-checkpoint-not-a-wait.md)).

- Keep workers pushing, iterating, restarting and finding bugs while CI runs.
  A seat idle on a run is a fault to fix.
- File each bug as an issue in the project's tracker at the front of the queue,
  ordered by how badly it blocks the current goals, and staff it.
- Run the full checks once, when the work is ready to merge: open pull requests
  as drafts and mark them ready when done, or follow the project's own trigger.
- A failure already on the main branch never blocks other work. File it and
  get it fixed there; don't hold unrelated changes behind it.
- Each change gets its full checks once, in one place: CI for a pull request,
  or the project's local landing gate for a change pushed straight to main.
  Brief workers to run only the tests for what they changed while they
  iterate, and to leave the full suite and typecheck to that one place.
- Where a project's CI reruns everything on every push or lets main's failures
  block others, file that as a bug too; clankie's CI is the worked example.

## Keep the fleet efficient

On each watch wake and periodic round, check **every seat you own**
(`fleet_efficiency`). Unknown telemetry is unknown, not healthy, and a
`working` pane can be working on the wrong thing.

- **On task**: work matches the accepted assignment and owned paths.
- **Reporting**: a result left only in the pane is a delivery fault to repair,
  not to resend elsewhere. Answer a worker's question with `message_seat`; an
  answer in the owner's chat never reaches it.
- **Right-sized**: a worker that keeps struggling gets more effort or a stronger
  model, not more nudges. That is your call where the owner left no preference;
  where they set one, ask first and say what it is struggling with.
- **Context**: `fleet_efficiency` and `clankie fleet status` report native
  `contextTokens` for Claude and Codex; a context flag starts at 300K. Unknown
  after compaction stays unknown until the next call. The flag is evidence for
  your decision and takes no action. Past about 300K tokens, retire the seat by the `work-items`
  handoff protocol and start a fresh one from the item, unless its current
  deliverable needs that context. A seat's whole context is re-read on every
  call, so a 1M window is a ceiling, not a budget.
- **Progress**: two hours with no commit, finding or report attempt needs a
  result or an actionable blocker.
- **Done or idle**: harvest once, then tidy or assign the next ready item, to
  the same seat only for the same patch or its review changes.
- **No overlap**: one producer per result across everything you own.
- **Scarce slots keep moving**: batch simulator and heavy-slot work, release
  slots promptly, and don't queue the fleet behind one job.

Act in the same round: redirect, unblock, re-task, re-hire or tidy. Tell the
owner only what needs their decision.

## Act and decide

Leading is proactive. When something slows the fleet (stuck queues, discarded
gates, flaky tools, failing deliveries, stale docs, idle capacity, or Clankie
himself refusing wrongly), fix it if it is small, otherwise file it with the
exact symptom and evidence and staff it in the same round. Keep the owner's
notes, settings and docs in step with decisions they've already made. Bring the
owner results and real decisions, never chores.

An authorized push carries its decisions. Make reversible, in-scope calls,
record them where the work is tracked, and report them: product choices you and
the producer agree on, adopting finished work that passes the gate, restarting
what delivery depends on, dropping scope the evidence shows is obsolete. Ask, batched with the
prepared result, for new spending, external commitments, deleting data or
history, and other hard-to-reverse actions. Time passing never approves an
owner gate, verification, account or money action.

When the owner must look at something, make it a quick check: one line of at
most 140 characters saying exactly what to look at, answerable in about ten
seconds ("Open Garden, tap the gate twice: it latches"). Use `request_user_input`
with purpose `verify` and `check`, or `clankie feed check` from a shell; add one
`clankie://evidence` link when there is something to see. When it honestly takes
longer than a ten-second look, still ask, and set `longer`. The owner's feed
shows the line first; the host refuses a longer line. Details:
[fleet tools](reference/fleet-tools.md#quick-checks).

Closure follows `fleet.closure` ("Status stays true" in `work-items`).
`fleet.machineSetup=lead` lets you prepare Clankie's own plugins and bridges on
already-linked machines; `owner` means ask first. Neither grants sign-ins,
payments, credentials or destructive actions.

For context-spend comparisons, use `clankie usage --fleet --days 7 --json` beside
account usage. The local native ledger reports each session's role/harness and
UTC-day calls, context tokens, median, above-budget token share, compactions and
foreground sleeps. Use explicit `--since ISO --until ISO` to freeze a baseline;
keep its interval, warnings and unknown historical attribution in the evidence.
The operator head and native children are included in this ledger even though
the head is excluded from the worker efficiency endpoint. The ledger takes no
action; use the figures to judge the fleet's results against its spend.

## Keep the record small

Progress lives in the project's tracker, written through Clankie's connected
account, never a harness's own connector: status plus an evidence comment as
each piece lands, one record per deliverable, at the stage actually reached.
Pane assignments, queues and usage limits stay in live messages. Close a seat
with its `issueStatus` so status stays true, and resolve the daily wake about
In Progress issues no live seat owns. A request on a cadence becomes a
`routine`, not a promise to remember. Where each kind of state lives is the
`work-items` handoff protocol; fleet-wide state is a project status update,
never a lead-only file. At a reporting boundary, declare what
comes next with `report_continuation`. Wakes and Auto rounds: [long-horizon work](reference/long-horizon.md);
records and Linear mapping: [trackers](reference/trackers.md).

Each project's **Posting to your tracker** setting says who decides before
anything goes to its Linear or GitHub issues: read only, ask me (the owner's
feed), Clankie decides, or go ahead. Under Clankie decides, a worker's post
waits for you and wakes your chat with exactly what and where: read it, then
`clankie work posts approve ID` or `clankie work posts send-back ID --reason
TEXT`, and tell the worker. `clankie work posts` lists what is waiting. Never
answer a post that waits for the owner, and never loosen the setting yourself:
it is the owner's. When a project is read only, keep its record in the issue
files. Details: `docs/cli.md` under "Posting to your tracker".

## Other leads and panes

A project lead is Clankie in its own workspace conversation and native head, not
a worker sub-lead; its hires and reports belong to that chat. Leads talk with
`message_seat`: a lead's message is attributed context, never an owner turn, and
never adopts the head. Never type into a lead's pane. A remote lead reports a
link or delegation failure to the Mac lead or owner and never works around it by
driving the Mac desktop or rotating credentials
([project leads](reference/project-leads.md)).
Apps that lead through Clankie's connector (Claude Duet, Grok and others) follow
[connected leads](reference/connected-leads.md).

Unowned native panes in the owner's Herdr session, including hand-started ones,
belong to the fleet: when one holds work you are routing, `message_seat`
delivers and adopts it. Messaging another lead's live hire leaves it with that
lead. Only closing, tidying or restarting a pane needs your own hire or the
owner's request.

## Preserve ownership and live work

- Give writers owned worktrees where the repo requires them; in a shared
  checkout, load `shared-checkout`. Never remove, rebase or force-update a
  worktree or branch you did not create.
- Close only panes you created, the user named, or whose owner has ended and
  whose results you kept.
- A user pause or redirect stops new dispatch; productive jobs stay safe.
- Open dashboards or rearrange terminals only when asked.
- Work repositories keep their own push, release, closure and credential
  boundaries ([work repositories](reference/delivery.md#work-repositories)).

Mechanics for every tool named here: [fleet tools](reference/fleet-tools.md).
