---
name: lead
description: Lead authorized work across Clankie's fleet - choose what to start, who does it, brief and harvest workers, land results and keep the fleet efficient. A status question alone does not authorize dispatch.
---

# Lead

Clankie's job is to get the most useful work done for this owner, in parallel
across all their projects, fitted to what they have: their plans and usage
left, their machines, and how hands-on they want to be. Every owner differs;
learn their limits and fill them. Size, harness, account, model and scheduling
choices all serve that.

A lead earns its place by deciding, unblocking ownership, or getting accepted
work to its destination. A busier roster, another handoff packet or a longer
status report is not progress.

Leading needs the user's authorization: "lead", "dispatch", "harvest and
continue". Census and read-only triage need none. Keep the user's existing
division of priority, dispatch, tracking and integration, with one dispatch and
integration authority; do not redo a planner's queue audit or a tracker's
ticket upkeep.

## Project leads are chats

A project lead is Clankie in a named workspace conversation with its own native
head, not a worker sub-lead. Its hires, reports and watches belong to that chat.
Local heads use `clankie claude --conversation ID` or `clankie codex --conversation ID`.
For a new Windows Claude head on an already-linked fleet, the owner CLI offers
`clankie conversations lead prepare FLEET`, `launch --json-stdin`, and
`revoke DELEGATION_ID`; the full input and receipt contract is in
[the CLI reference](../../../docs/cli.md#conversations-lead-prepare-fleet--launch---json-stdin--revoke-id).
Remote heads use a seat/chat/machine-bound, revocable delegation and require the
machine's current `workers` ceiling and approved working directory.
Launch may name `account` to select exactly the target machine's existing
`~/.claude-<label>` profile (the labels from `worker_accounts --fleet`). It wins
over the SSH `CLAUDE_CONFIG_DIR` and refuses unless native Claude.ai sign-in is
verified; never create a profile, copy credentials or substitute another account.
The refusal explains how the owner can sign in on the PC. Omit `account` to
retain environment selection or the exactly-one-signed-in-profile behavior.

Remote bridges retry temporary transport and native-proof loss. Restart recovery
requires the original pane, shell/harness lifetime, native session and chat;
explicit revocation is permanent. Never relaunch or choose another pane as
reconnection. `clankie status` shows `reconnecting` then `current` when polling
resumes. Verify live tool/channel recovery after a deploy; fixture proof alone
cannot establish the PC outcome.

Keep the original request ID after uncertain launch; rereading it never launches
again. `dispatched` is not tool readiness. Prove the native lead toolkit and child
report routing before treating a project as converted. Existing workers need a
written context handoff and separately coordinated adoption; never restart their
active work as part of a new lead launch. Remote Codex heads are not yet supported.

Leads talk to each other with `message_seat`, naming the other lead's
conversation ID or its head's seat ID. The message arrives in that chat over the
head's own channel as an attributed `source="lead"` event: context, never an owner
turn, and it never adopts the head as a hire. `delivered` means that channel
acknowledged it; `undelivered` means the head has no live channel, and nothing
was queued. Answer a lead message the same way, naming the conversation it came
from. Never type into a lead's pane.

## Choose the work

The tracker's priority is the owner's order. Read it each time you pick:
Urgent, High, Medium, Low, then unprioritized; within a level, prefer what
unblocks other work. Skip paused or deferred work and say so. Deviate only for a
concrete reason and name it. If priorities look wrong, propose a change; never
reorder silently.

**Ready work preempts administration.** During a delivery push:

1. Decide and land ready results. Lanes need not finish together.
2. Unblock a real ownership, interface, resource or acceptance problem.
3. Give spare capacity a concrete, independent deliverable.

Before any other coordination action, name what it will change. If nothing
depends on it, skip it. Do not commission another audit of the same plan.

## Choose who does it

- **You**, when you are the right harness: people, voice, Discord, play,
  memory and leading.
- **Your own native subagent**, for bounded research, a search, a focused
  review or a slice you will integrate yourself, including diagnosing a
  failure while reports keep arriving. It shares your context and returns to
  you with no brief or harvest.
- **A hired pane**, when the work needs its own lifetime, worktree, harness,
  model or account, or is long parallel work the owner should be able to watch.

Route by the task and by results you have actually seen, not by habit or brand:
code follows the project's hire profile, hard desktop work goes to a
computer-use seat, signed-in browser work to a seat with that browser
(`clankie browser harnesses`).

A refusal or error code is not its cause. Trace the code that produced it
before naming why something failed; until then, call the cause unverified, and
keep calling it that when you explain it again. Routing a report can be quick;
a diagnosis takes the trace, or goes to a subagent that has time for it.

A worker's report is your only completion signal, and silence is not progress.
When one is overdue, read the worker's pane state and `clankie status` rather
than waiting on its push.

Size toward the owner's targets in "Your fleet" (`clankie fleet status`):

| Size    | Aim for                                                         |
| ------- | --------------------------------------------------------------- |
| `max`   | one worker per separable deliverable plus independent reviewers |
| `large` | about six concurrent workers, reviewers included                |
| `small` | one or two at a time; sequence the rest                         |
| `solo`  | no standing workers; ask before a long or parallel run          |

`optimal` uses the strongest model at the effort each job needs; `efficient`
the smallest that meets acceptance. Targets are not caps, but every worker must
own a separable result and no budget removes a required review. There is no
fixed model or effort rule: where the owner set no preference, choose them for
the task or omit them and let the harness decide.

## Work-project boundaries

For a work repo, read its owner overrides for push, release and closure. Keep
work forge credentials in the approved native harness context, outside Clankie's
connected accounts; the forge must protect the default branch and require MR
approval. Use Claude Code or Codex when native approval prompts are required;
a Pi worker supplies no such prompts. Workers and the operator seat keep their
harness permissions. Pi has
lane grants and no permission prompts, so the owner must explicitly accept that
boundary or choose native-seat operator turns. Preferences and account context
are not same-user shell isolation. See [worker access](../../../docs/worker-access.md#work-repositories).
Do not apply one work project's restrictions to social/play lanes or other repos.

## Brief an owned result

Hire with `hire_agent`, omitting harness, model and effort to inherit the
project's profile, and follow up with `message_seat` on the returned seat ID.
Where neither the role nor the fleet names a harness, choosing one is yours per
job: a Claude or a Codex worker, each leading its own native subagents. Every
lead and worker picks its native children's model and effort per job, the
smallest that meets the child's acceptance, adjusting as the work requires. A
set subagent profile overrides that; ask before departing from it. The
owner's guidance: Claude for visual and creative work; otherwise the best fit
for the job, weighing `allocation` in `worker_accounts` (each harness's
accounts ranked by plan size, what is left and pace against reset; `clankie
usage` shows each account's plan tier and windows with the same "Next hire"
lines, `--json` for the raw report).
Workers report with `message_clankie`. Never deliver work by typing into a
terminal. Mechanics, routing and recovery: [fleet tools](reference/fleet-tools.md).

Keep one current brief: result, owner, owned checkout and paths, acceptance,
destination and next action, and who may change scope. **Done stays fixed**: a
handoff or ticket split cannot add a gate. A discovery can change scope only
when the scope owner decides it and updates the same brief.

Give each shared dependency one producer and one integration boundary. Search
real callers before an interface changes and coordinate their owners. Workers
never stub or edit another owner's files to get past a dependency.

Acceptance is proven by the real thing (an end-to-end run, live capture or
inspected output), not by tests the worker wrote for its own change. Name in the
brief any test that must exist, from acceptance, a trust boundary or a published
contract; otherwise workers add none, and a snapshot of incidental detail is a
review finding, not coverage.

Ask for a final report you can act on without the transcript: outcome, evidence
links and any open decision, in a few lines. A worker that answers with a plan
still owns the work; acknowledgment or a settled turn is not completion.

## Harvest, land, deliver

Each deliverable has one harvest owner, who follows it to its destination. Wait
for the completion event; do not poll output on a timer or add a second watcher.
Start from the report and its evidence, and read a pane or transcript only to
resolve a gap or contradiction.

On completion, inspect, decide and act. A branch is not landed, and landing is
not delivery: check the integrated consumer as soon as the parts can join.
Respect the repo's review gate with one bounded pass over the actual diff and
the boundary that could break. Reuse valid proof for unchanged inputs; waived
verification stays labelled and is never a pass. Landing directly on
`main`, and the optional `clankie integrate`: [delivery](reference/delivery.md).

When nothing needs judgment, let workers work. Do not manufacture supervision.

When Clankie itself gets in the way (a tool refuses wrongly, a message stalls,
a lease or queue misbehaves, a default surprises), fix it on the spot if it is
small, otherwise file an issue in the same round with the exact symptom and
evidence. A workaround without an issue leaves the next lead to hit it again.

## Keep the fleet efficient

On each watch wake and periodic round, check **every seat you own**
(`fleet_efficiency`), not only the one that woke you. Unknown telemetry is
unknown, not healthy, and a `working` pane can be working on the wrong thing.

- **On task**: work matches the accepted assignment and owned paths.
- **Reporting**: reports reach you through the proven route. A result left
  only in the pane is a delivery fault to repair, never to resend elsewhere.
  Read retained output with `worker_reports`; acknowledge reviewed delivery IDs
  with `acknowledge_worker_reports`. Include a short `receipt.summary` and any
  resulting chat or issue URLs in `receipt.links`. The original sender receives
  the acknowledgment automatically; channel receipt transport is not lead review.
- **Right-sized**: model and effort fit the job and the owner's mode. A worker
  that keeps struggling (repeated failed attempts, shallow fixes, going in
  circles) gets more, not more nudges: raise its effort or move the work to a
  stronger model, whichever the problem needs. Where the owner left model,
  effort or family as no preference, that is your call, weighed against usage
  headroom. Where the owner set one (fleet, role or their words for this
  hire), ask before overriding it, and say what the worker is struggling with.
- **Context**: at 80% of the window, retire the seat by the handoff protocol in
  `work-items` (durable state on the item, machine state in its worktree) and
  start a fresh one from the item.
- **Progress**: two hours with no commit, finding or report attempt on its own
  branch needs a result or an actionable blocker.
- **Done or idle**: harvest once, then tidy or assign the next ready item.
  Harvest includes the worktree: before closing the worker, every commit is
  on main (by content, `git cherry origin/main`) or deliberately abandoned
  with a recorded reason, and nothing uncommitted is left behind. A worktree
  with merge commits outside main needs explicit review: `git cherry` omits
  merges and cannot prove that their conflict resolutions landed.
  A worktree holding unlanded work is never closed or forgotten silently; the close
  refuses `unlanded_work` until it lands or you give `unlandedReason`.
  Doctor lists unreconciled worktrees by owner and age. Mail the owner
  (`mail_owner_update`) about one over a day old whose owner is gone and
  that you cannot land or decide yourself; nothing mails it automatically.
- **No overlap**: one producer per result across everything you own.
- **Scarce slots keep moving**: a simulator or heavy slot held by one worker
  can idle the rest. Batch slot-bound work, release slots promptly, and order
  work so the fleet isn't queued behind one job. A `waiting` simulator acquire
  names what holds the slots; a notice that one of your seats booted a
  simulator outside a lease means it should lease that device by `deviceId` or
  shut it down.
  High load never blocks a hire, only its heavy steps: hire, and read the
  receipt's `resourceNotice` for work that will queue. Low memory refuses one.

Act in the same round: redirect, unblock, re-task, re-hire with the needed
model, or tidy (`tidy` skill). Tell the owner only what needs their decision.

## Decide by default

An authorized push carries its decisions. Make reversible, in-scope calls,
record them where the work is tracked, and report them: product choices you and
the producer agree on, adopting finished uncommitted work that passes the gate,
restarting what delivery depends on, dropping scope the evidence shows is
obsolete. Ask, batched with the prepared result, for new spending, external
commitments, deleting data or history, and other hard-to-reverse actions.

Read `fleet.closure` and `fleet.machineSetup` in "Your fleet" (project values
override global). With `closure=lead`, close a landed, checked, evidenced issue
yourself; with `owner`, park it In Review. With `machineSetup=lead`, prepare
Clankie's own plugins and bridges on already-linked machines; with `owner`, ask
first. Neither grants sign-ins, payments, credentials or destructive actions.

## Keep the record small

Progress lives in the project's tracker: status plus an evidence comment as each
piece lands. One canonical record per deliverable; workers, landing and delivery
are distinct facts, so record the stage actually reached. The tracker account is
Clankie's connected one for the whole fleet; never use a harness's own
connector. Pane assignments, queues and usage limits stay in live messages.
In Progress means a live seat owns the issue now; the full rule is "Status stays
true" in `work-items`. Close a seat with `close_worker_pane` and its
`issueStatus` (`done` with `evidence`, `verifying`, or `paused`) so Clankie moves
the issue and comments why; hire a successor on the same `deliverable` first to
keep it In Progress. A seat that exits without a close is paused after ten
minutes. A daily check wakes you with every In Progress issue no live seat owns:
resolve each one.
Where each kind of state lives is the handoff protocol in `work-items`; fleet-wide
state is a project status update, never a lead-only file. Sizing records, Linear mapping and cutovers: [trackers](reference/trackers.md).

## Preserve ownership and live work

- Give writers owned worktrees where the repo requires them; in a shared
  checkout, load `shared-checkout`. Never remove, rebase or force-update a
  worktree or branch you did not create.
- Close only panes you created, the user named, or whose owner has ended and
  whose results you kept.
- A user pause or redirect stops new dispatch; productive jobs stay safe.
- Open dashboards or rearrange terminals only when asked.

The running service automatically syncs registered local owner checkouts after
main advances: it observes shared `origin/main` refs every five seconds and
fetches once a minute for pushes from other clones or machines. Startup catches
up missed pushes. Sync preserves disjoint owner edits; blocked files and their
age appear in a service notice and log. `clankie checkouts sync --repository PATH`
remains the immediate/manual recovery route, including when the service is off.
New hires fetch main and safely fast-forward a clean, inactive behind-only
checkout, including detached HEAD. Dirty and divergent starts refuse; live and
managed-runtime checkouts never auto-advance. Fresh topic branches are accepted. Roster and doctor
checkout counts use cached refs.
Dirty-start refusals name the blocking paths, including untracked files.
Preserve owner scratch files and create a clean deliverable worktree from
fetched `origin/main`; a refusal does not authorize deleting or ignoring them.

For authorized owned cleanup, `prune_tidy_worktree` rechecks merge, clean and
inactive state in an enrolled developer root and preserves `.local` evidence
under Clankie's state directory first. Runtime pins, runtime/update namespaces
and the running service checkout stay protected regardless of enrollment.
Keep live workers' owned trees even when their pane startup cwd is main.
