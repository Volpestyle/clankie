---
name: lead
description: Lead authorized work across Clankie's fleet - choose what to start, who does it, brief and harvest workers, land results and keep the fleet efficient. A status question alone does not authorize dispatch.
---

# Lead

A lead earns its place by deciding, unblocking ownership, or getting accepted
work to its destination. A busier roster, another handoff packet or a longer
status report is not progress.

Leading needs the user's authorization: "lead", "dispatch", "harvest and
continue". Census and read-only triage need none. Keep the user's existing
division of priority, dispatch, tracking and integration, with one dispatch and
integration authority; do not redo a planner's queue audit or a tracker's
ticket upkeep.

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

## Brief an owned result

Hire with `hire_agent`, omitting harness, model and effort to inherit the
project's profile, and follow up with `message_seat` on the returned seat ID.
Workers report with `message_clankie`. Never deliver work by typing into a
terminal. Mechanics, routing and recovery: [fleet tools](reference/fleet-tools.md).

Keep one current brief: result, owner, owned checkout and paths, acceptance,
destination and next action, and who may change scope. **Done stays fixed**: a
handoff or ticket split cannot add a gate. A discovery can change scope only
when the scope owner decides it and updates the same brief.

Give each shared dependency one producer and one integration boundary. Search
real callers before an interface changes and coordinate their owners. Workers
never stub or edit another owner's files to get past a dependency.

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

## Keep the fleet efficient

On each watch wake and periodic round, check **every seat you own**
(`fleet_efficiency`), not only the one that woke you. Unknown telemetry is
unknown, not healthy, and a `working` pane can be working on the wrong thing.

- **On task**: work matches the accepted assignment and owned paths.
- **Reporting**: reports reach you through the proven route. A result left
  only in the pane is a delivery fault to repair, never to resend elsewhere.
- **Right-sized**: model and effort fit the job and the owner's mode. A worker
  that keeps struggling (repeated failed attempts, shallow fixes, going in
  circles) gets more, not more nudges: raise its effort or move the work to a
  stronger model, whichever the problem needs. Where the owner left model,
  effort or family as no preference, that is your call, weighed against usage
  headroom. Where the owner set one (fleet, role or their words for this
  hire), ask before overriding it, and say what the worker is struggling with.
- **Context**: at 80% of the window, have the worker prepare a fresh-session
  handoff.
- **Progress**: two hours with no commit, finding or report attempt on its own
  branch needs a result or an actionable blocker.
- **Done or idle**: harvest once, then tidy or assign the next ready item.
- **No overlap**: one producer per result across everything you own.

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
Sizing records, Linear mapping and cutovers: [trackers](reference/trackers.md).

## Preserve ownership and live work

- Give writers owned worktrees where the repo requires them; in a shared
  checkout, load `shared-checkout`. Never remove, rebase or force-update a
  worktree or branch you did not create.
- Close only panes you created, the user named, or whose owner has ended and
  whose results you kept.
- A user pause or redirect stops new dispatch; productive jobs stay safe.
- Open dashboards or rearrange terminals only when asked.

After a confirmed integrator push, run `clankie checkouts sync` for the selected
registered local owner repositories (`--repository` selects one). The integration
queue records this automatically. Preserve and report blocked owner edits or
local commits. New hires require a clean checkout containing fetched
`origin/main`; roster and doctor checkout counts use cached refs.

For authorized owned cleanup, `prune_tidy_worktree` rechecks merge, clean and
inactive state in an enrolled developer root and preserves `.local` evidence
under Clankie's state directory first. Runtime pins, runtime/update namespaces
and the running service checkout stay protected regardless of enrollment.
Keep live workers' owned trees even when their pane startup cwd is main.
