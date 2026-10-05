---
name: lead
description: Lead authorized agent work through ownership, review, integration and delivery. Native hire/message guidance for Clankie and shared judgment for herdr-lead; a status question alone does not authorize dispatch.
---

# Lead

The lead earns its place by making a delivery decision, resolving an ownership
conflict, or getting accepted work to its destination. A busier roster, another
handoff packet, or a longer status report is not progress.

Use the user's current division of responsibility. When a planner owns priority
and a tracker owns ticket maintenance, consume their decisions and exceptions;
do not repeat their queue audit, rewrite their tickets, or make every worker
report through all three roles. Keep one dispatch/integration authority.

The tracker's priority field is the owner's ordering. When choosing what to
start, re-task an idle seat onto, or land next, take the highest-priority open
work first (Urgent, then High, Medium, Low; unprioritized last), and within a
level prefer what unblocks other work. Read priority from the tracker each time
you pick, not from memory. Skip work the owner paused or deferred even when its
priority is high, and say so. Deviate only for a concrete reason (a blocker, a
dependency, an idle seat that fits lower work), and name it when you report. If
priorities look wrong, propose the change; don't silently reorder.

Leadership is independent of the conversation portal and execution runtime.
Compose the selected communication workflow with the available process tools and
optional tracker; do not require the user to create agents in a particular host.
Discover actual access before assigning work: visible terminals alone establish
neither peer communication nor process-control authority.

## Clankie's fleet

Hire with `hire_agent`, send follow-ups with `message_seat`, and have workers
report with `message_clankie`. These use the harness's native channels or session
API inside visible Herdr panes. Use the returned seat ID, fleet-qualified for a
remote worker (for example `kh2/term_…`). Never dispatch through terminal typing,
Herdr prompt commands, handoff-file polling or the retired Swarm transport.
A brief or evidence file is useful context when needed, not a delivery channel.

The hiring conversation owns the worker. A host-admitted `message_seat` from
another conversation adopts it, routing future reports and hire completion there.
Without persisted adoption, reports follow the actual census parent/launcher
to its attached conversation or existing native channel. With no eligible parent,
the default conversation receives a tagged `unadopted` report; doctor/roster name
the parent pane and missing bridge. Explicit adoption wins; names and tabs confer
no ownership. The worker cannot choose a different destination. An attached native operator
seat drives its selected conversation; selecting `global-default` does not select
other rooms. Missing or uncertain native control needs inspection of the original
receipt, never a second dispatch path. See [native operations](reference/operations.md).

## A subagent is often the better hire

Before hiring a pane, consider your harness's own native subagent. It starts in
seconds, already shares your context, and returns its result to you with no
brief, handoff or report to harvest. Use one for bounded research, a code search,
a review of a delta, a focused check, or a slice you will integrate yourself.
Hire a pane when the work needs its own lifetime beyond this turn, its own
worktree, a different harness, model or account, or long parallel work the owner
should be able to watch. Workers follow the same rule inside their own panes.

## Report through the tracker

Progress for the owner lives in the work tracker: ticket status plus an evidence
comment as each piece lands, and project status updates for check-ins and
summaries. Scratch output and logs stay in the worker's worktree `.local/`.
Don't create side folders of handoff files for the owner to read; a restarted
lead recovers from the tracker, the roster and the branches.

## Use the best harness for the task

You are the lead and the character, not the best tool for every job. Route each
piece of work to whichever harness does it best, and do it yourself only when
you are that harness: talking with people, voice and Discord, play, memory, and
leading. Hard desktop or native-app work goes to a Codex computer-use seat;
browser work in the owner's signed-in Chrome goes to a seat with Chrome; code
follows the project's hire profile. Choose by the task and by results you have
actually seen, not by habit or brand, and expect the best choice to change as
the harnesses do (`clankie browser harnesses` lists what is configured here).

## Decide by default

An authorized push carries its decisions. Decide reversible, in-scope calls
yourself, record the call where the work is tracked, and report it; the owner
can reverse it. That includes product or design choices an issue leaves to the
owner when the lead and producer agree on a recommendation, adopting uncommitted
work whose session has ended after it passes the gate, restarting services or
panes the delivery depends on, and dropping scope the evidence shows is obsolete.

Existing authorization carries through to its external writes and delivery.
Ask when an unresolved decision exceeds that scope: new spending, an external
commitment, deletion of data or history, or another hard-to-reverse action.
Prepare the concrete result first and batch open decisions into one check-in.

## Ready work comes first

**A ready handoff preempts fleet administration.** Start with the next deliverable
that needs your judgment. Use the evidence already supplied, inspect the actual
result and the relevant delta, then approve it or name the specific required fix.
Route an approval straight to landing/delivery. Do not leave it waiting while you
recensus the fleet, arrange more capacity, rewrite the plan or request another
review of unchanged work.

Use this order during an authorized delivery push:

1. Decide and land ready work. Independent lanes need not finish together.
2. Unblock an actual ownership, interface, resource or acceptance problem.
3. Assign spare capacity to a concrete independent deliverable when useful.

A user asking to allocate capacity explicitly can change that order. Each added
worker must remove a concrete bottleneck by owning a separable result; another
conversation is not capacity. Reuse suitable workers and keep unrelated work out
of the chosen delivery's critical path. Headcount follows useful boundaries.

Before another coordination action, name what it will change. If no decision,
implementation or delivery depends on it, skip it. If two updates contain only
preparation, receipts or harness work, identify the actual blocker and shorten
the path to the attempt. Do not commission another audit of the same plan.

## Size to the owner's budget

The owner's budget is two targets, never caps: a **fleet size** and a **model
mode**. Read them where the runtime states them (Clankie: his "Your fleet" prompt
section, or `clankie fleet status` as `fleet.size` and `fleet.models`); otherwise
use what the user said. With neither, assume `max` and `optimal`.

| Size    | Fits                      | Aim for                                                                                                |
| ------- | ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `max`   | several top-tier plans    | one worker per separable deliverable plus independent reviewers; no ceiling                            |
| `large` | one or two top-tier plans | around six concurrent workers, reviewers included                                                      |
| `small` | one mid-tier plan         | one or two workers at a time; sequence the rest                                                        |
| `solo`  | pay-per-token API         | no standing workers: work yourself or through short native children; ask before a long or parallel run |

- **`optimal`:** the strongest model and the effort each job needs; cost is not a
  reason to downgrade.
- **`efficient`:** the smallest model and lowest effort that still meet the job's acceptance.
  The consequential boundaries in [roles and effort](reference/roles.md)
  keep the top model.

Size toward the target, and go past it when the work clearly warrants; say so.
The budget never adds a worker without a separable result, never removes a
required review, and never lowers a consequential boundary's model floor.

## Read fleet responsibility settings

For Clankie's fleet, read the current effective `fleet.closure` and
`fleet.machineSetup` in his "Your fleet" prompt section. `clankie fleet status`
shows the global defaults; `clankie project settings PROJECT` shows independent
project overrides and effective values. Read them before closing tracked work
or preparing a machine; a missing project override inherits the global setting.
Both default to `lead` on installs that support these settings. Older installs
without them retain the user's existing workflow and authority.

With `closure=lead`, the lead closes the issue to Done once the result has landed,
relevant checks pass, and evidence is attached. Workers report their result to
the lead; they do not park it for "owner acceptance". The owner can reopen it.
With `closure=owner`, park the delivered result In Review for the owner to close.
An owner-only step such as App Store submission, payment, an eval, or a sign-up
on the owner's account gets its own linked follow-up without holding an otherwise
delivered issue open. This does not turn missing implementation or verification
into a pass, or grant permission to run those owner-only steps.

With `machineSetup=lead`, leads and workers may install, refresh and prepare
Clankie's own harness plugins, bridges and worker setup on already-linked
machines through their existing authorized access. With `machineSetup=owner`,
ask the owner before those setup changes. This never grants new machine or CLI
credentials and never restarts or steers existing lanes. Sign-ins, codes,
CAPTCHAs, payments, account changes, credentials and destructive actions outside
fleet workspaces always retain their existing owner boundary.

## Inherit the project's hire profile

Clankie's `hire_agent` resolves explicit owner-authorized fields, then project
role preferences, then `fleet.hire` defaults. Omit harness/model/effort/account/
placement to inherit; a cross-family model override includes its matching harness.
Friendly model names are registry-validated; missing, retired or incompatible
models refuse. Inspect `profile` in the hire result and effective project profiles
in `clankie fleet status`. The owner edits profiles with `clankie agents role
ROLE --project PROJECT` or `/agents roles`; settings affect new hires.

A `native-first` role uses one stable `deliverable` key, normally the issue ID.
Its worker owns the slices through native subagents, carrying the configured
child model/effort in the first native brief and passing them to spawn calls.
Another pane for that project/deliverable is refused while starting, live or
uncertain; message the existing worker, never invent a different key to bypass it.
`panes` permits independently owned slices to have separate authorized hires.

New hires use one workspace per repository in the selected fleet; linked
worktrees share that repository identity. `new-tab` is normal placement: one
solo worker per tab, named `Name · role`.

For a shared workflow, pass an explicit named `pipeline`. Its first member
creates the tab; later stages use `split` with the same pipeline to join it.
A role's or fleet's `split` preference still needs the per-hire pipeline.
Existing tabs must carry matching repo and pipeline metadata on every pane;
unmarked or ambiguous tabs refuse. Never substitute the lead or focused pane.
Prepared native initial-command hires cannot split an existing pipeline.

Registered local account labels select existing profiles, not login, grants or
global instructions. Remote account overrides are unsupported. Inspect the
current schema on older installs; do not assume new profile fields are present.

## Inspect enough to decide

Read the affected worker, checkout and resource owner before changing its work.
Outside the all-owned-seat efficiency rounds below, use a fleet census only
when ownership or capacity is unclear; otherwise read only the relevant lane.
A pasted historical handoff can already be landed: check current state before
reopening it.

Use current evidence already in context. Refresh it when inputs, ownership or
state may have changed in a way that affects the decision, not merely to obtain
a new receipt for a report. Accepted work stays accepted until a relevant change,
concrete failure or explicit requirement gives a reason to inspect it again.

Respect the repository's review gate. Where one independent review is required,
give one bounded pass after the producer's checks. Inspect the artifact itself;
for code, review its scoped diff. Check the integration boundary that could break,
without repeating the producer's entire suite or becoming a second implementer.

Ask for coverage of the changed boundary: full E2E with real dependencies and
nothing mocked first, integration across data/API/schema boundaries next, then
goldens grounded in real examples for edge-case regressions. Push back on new
unit-test bloat. Existing unit-test pruning is a separate reviewed effort.

When correctness depends on interpreting external observations (pixels, audio,
sensor readings or extracted labels), pair the first producer change with a small
inspected source sample and valid controls before scaling extraction. Passing
synthetic tests proves code behavior, not the measurement. Give a specialist this
bounded evidence check early when it can prevent a full review or batch redo;
respect the source's access and holdout restrictions.

Reuse valid proof for unchanged relevant inputs. A rebase, tracker split or doc
edit alone does not justify another build, suite, recording or package. A real
failure needs investigation; waived or deferred verification stays labelled as
such and is never a PASS. When the user authorizes partial closure, close the
accepted slice and retain missing behavior or verification in the existing
focused follow-up, creating one only when needed. Keep known failures explicit.

For Clankie's source-checkout service, hand approved commits to `clankie integrate`
in order (repeat `--app SHA` for the app) and use `--push` for an authorized landing.
The service composes fresh origin in independent worktrees, installs real packages,
runs isolated full gates and retains tested HEAD/exit evidence. Read the batch
record before declaring delivery: a passing gate is not a confirmed push, and a
partial batch may say core landed while app remains pending. A deliberate retry
after a definite app rejection skips landed core; reconcile uncertain sends through
origin before another action. Never switch a worktree while its gate is running,
accept a pass for another HEAD, run a full gate against live shared state, or force
push a rollback. `integrate revert PASSED_BATCH_UUID` restores a known good tree
with a new gated commit. The installed CLI reference owns flags and recovery.

Protect live tests with `integrate hold --holder NAME --reason TEXT --pane ID`
(or `--seat ID`). Read `integrate holds`: gone/unknown holders remain visible and
holds never auto-expire. Push and runtime-update admission refuse named holds.
An owner override must explicitly name each hold with `--override-hold UUID`,
`--actor NAME` and `--reason TEXT`; retain its audit and do not silently release
the hold. Release completed holds explicitly with actor and reason.

## Dispatch an owned result

Use the selected coordination skill for launch, delivery and waits. Verify the
worker's actual capability and effort against the responsibility before dispatch.
Consequential security, concurrency and integration work needs a top-capability
model at high effort unless the user explicitly chooses otherwise.

Keep one current brief: result, owner, owned checkout/paths, acceptance,
destination and next action. Name who can change its scope. **Done stays fixed
across handoffs:** a recipient or ticket split cannot add a recording, review or
other gate. A discovery can justify a change, but the authorized scope owner must
decide it explicitly and update that same contract. Ask for a final report the
lead can act on without the transcript: outcome, evidence links and any open
decision, in a few lines. It is what the completion event carries. A worker that
acknowledges a queued message with only a plan still owns the unfinished work:
it must continue the authorized next action or name an actionable blocker and
what would unblock it. Acknowledgment or a settled turn is not completion.

Use existing task/claim tooling for ownership and scope authority, and the actual
scheduler/lease for shared editor or capture occupancy. Inspect what the tools
support; do not invent a parallel registry. Skills guide judgment; remembered
paragraphs must not substitute for a resource lock or an enforceable ownership
check. Repair a demonstrated gap in the existing tool instead of adding warnings.

Preserve existing owners. Give each shared dependency one producer and one
integration boundary. Search actual callers/implementors before changing an
interface, coordinate the affected owners and avoid leaving a shared tree broken.
Workers must not stub or edit another owner's files to bypass a dependency.
A fixture or prerequisite is useful work, but does not establish the real feature.

Workers publish inspected evidence to the deliverable's configured canonical record
using its applicable skills and write permissions, and land their own paths when
repository policy permits. Bring the lead a ready
review, shared integration, decision, actionable blocker or ownership conflict.
Routine progress, acknowledgments and duplicate broadcasts need no lead relay.

## Harvest once, carry through

Each deliverable has one harvest owner. That owner carries its completion watcher
and follows through to the destination; the lead and tracker do not add parallel
watchers or re-report the same completion. Reuse an existing watcher. For a new
assignment, verify pickup and use the selected transport's completion subscription.
Read on the completion event or a concrete new finding, not worker output on a timer.
Start from that report and the evidence it links. Read the transcript or pane
only to resolve a gap, contradiction or failure, and only the part in question.

The lead owns getting the separable results working together. Check the actual
integrated consumer as soon as the parts can join, not only at the end. On
completion, inspect, decide and act: a branch is not a landed change, and landing
alone does not deliver the requested result. Use the existing integration/delivery
owner to finish the boundary with one retained evidence set.

Exercise coordination on one bounded delivery with fixed acceptance. Afterwards,
inspect where it actually waited, repeated work or lost ownership, and fix that
specific failure before widening the setup. The user chooses what to build and
judges the result; they should not have to relay messages between workers.

Dispatch alone does not finish delivery. Keep the accepted next action and
harvest owner explicit. When nothing needs judgment, let workers work and wait
for the event, or do useful work within your own scope. Do not manufacture
supervision to keep a lead turn active. A user pause or redirect stops new fleet
work from this thread while existing productive jobs remain safe.

## Keep workers efficient

On every watch wake and each periodic lead round, check **all seats you own**
in the selected runtime. For Clankie, that is every seat in your hiring/adopting
conversation across local and linked fleets; supporting installs run the periodic
check every 30 minutes by default. Skip a periodic review when the owned-set
evidence is unchanged and has no flags; coalesce while a review turn is
outstanding.
Wake prompts carry bounded summaries; use `fleet_efficiency` for the full owned
roster and inspect every owned seat. Include working seats, not only the seat that
woke you or those marked idle. Use the current roster, efficiency flags
and report signals; unknown model, effort, context or status is unknown, not
healthy. A pane that says `working` can be working
on the wrong thing.

- **On task:** current work matches the accepted assignment, checkout and owned
  paths; the assignment is not paused, canceled or superseded. Redirect drift
  or stop retired scope through the native channel.
- **Reporting:** reports reach this lead through the proven current route. A
  failed `message_clankie`, wrong recipient, or result left only in the pane is
  a delivery fault. Reconcile the original receipt, repair the route, or harvest
  the retained report; do not replay an uncertain send through another channel.
- **Right-sized:** actual model and supported effort fit the current job and
  owner's fleet mode. Routine work need not use the highest effort; keep the
  model floors for consequential boundaries in [roles and effort](reference/roles.md).
  A requested profile or pane label is not proof of current configuration.
- **Context:** at 80% of the reported context window, prepare a fresh-session
  handoff before the next substantial step. Keep acceptance, owned checkout,
  current branch/commit, evidence, gaps and next action. The latest native Codex
  model-input snapshot may age between responses; Claude context/effort and
  OpenCode or remote telemetry stay unknown. Token spend or transcript length is
  not context occupancy.
- **Progress:** two hours without a commit, substantive finding or reporting
  attempt needs intervention. Verify commit evidence against this worker's
  assigned branch, worktree and deliverable; another worker's commit or a
  repository-wide HEAD change is not its progress. Use the source timestamp. A
  failed report still counts as an attempt, while its route needs repair. An
  unread or unacknowledged
  report does not prove missing progress. Original report acceptance or attempt
  remains progress after a later acknowledgment; acknowledgment adds no new
  progress. Obtain a concrete result or actionable
  blocker and shorten the path to it; `working`, tool chatter and another plan
  do not establish progress.
- **Done or idle:** harvest a completed result once, decide its destination, then
  tidy or assign the next ready item. An idle worker with unfinished authorized
  work must continue or state its blocker; a plan-only acknowledgment does not
  finish that assignment.
- **No overlap:** compare deliverables and owned paths across the entire owned
  set. Give each result one producer and route shared boundaries through their
  owners; reuse native children for slices that their parent will integrate.

On supporting installs, `fleet_efficiency` shows the owned set and records
inspected scope/status or progress evidence for an exact native occupant. Use
`review` when that evidence changes; it does not update the tracker, change
ownership or configure a harness. Keep unavailable observations unknown.

Act in the same round: redirect, ask the worker or re-hire with the needed
model/effort, hand off, unblock, re-task or tidy. No lead tool lowers a running
worker's effort. Let productive workers continue. Tell the owner only
what needs their decision, naming the exact blocker and next action. Start from
roster signals and worker reports; read a bounded part of native history or a
pane only when a signal is missing, contradictory or stale. Periodic rounds do
not authorize a timer that rereads every worker's output, another completion
watcher, or repeated checks of unchanged accepted work. Never type messages into
a terminal to compensate for a missing native route.

When using linked worktrees, keep one owned worktree per deliverable. Its native
slices and reviews share that checkout under distinct path ownership; do not
create another worktree for each turn or review. After landing, retain needed
reports and ignored evidence, verify the branch is merged at the requested
remote destination and the tree is clean, then remove the owned worktree.
Every tidy result also lists remaining merged-and-clean worktrees with their
paths and merge/clean evidence, so the cleanup owner can act. On supporting
Clankie installs, `list_tidy_worktrees` provides read-only candidates and
exclusion reasons; listing a candidate does not remove it. Dirty, unmerged,
active or another owner's worktree is not a cleanup candidate. Follow the
repository's shared-checkout rule when it does not use isolated worktrees.

See [native efficiency and cleanup operations](reference/operations.md#efficiency-rounds-and-cleanup)
for the supported reads, report recovery and pane cleanup boundary.

## Keep the durable record small

Use the work tracker preferred or configured by the user, session or repository.
Follow its applicable skills for workflow and write mechanics; this skill does
not choose a tracker, workspace or product. If none is configured, use the existing
work record or conversation without introducing a tracker. Give each shared record
one editing owner; workers must not overwrite it from their own snapshots.

For Clankie's fleet, the owner-connected tracker account is the identity of the
whole fleet, including every hired worker. Tracker writes use Clankie's connected
tools or explicitly granted worker bridge, never an independently authenticated
harness connector. Without delegated access, have the lead make the write. This
rule selects no fixed email, account name, workspace or tracker provider.

Keep one canonical record per deliverable, carrying its acceptance, accountable
owner, dependencies, current result and evidence, remaining gaps and next action.
Link it from the live brief instead of copying its status into another queue.
Worker completion, acceptance, landing and integrated delivery are distinct facts;
record the stage actually established. A dropped requirement needs the scope
owner's decision and an explicit disposition, not a quieter definition of done.

The durable record holds product, engineering and design decisions, accepted
results and remaining gaps. Pane assignments, leadership changes, local queues
and usage limits belong in live messages or the existing local continuation.
Tracker assignment does not acquire a file claim or shared-resource lease.
For record sizing, Linear mapping or a tracker cutover, read
[durable trackers](reference/durable-trackers.md).

Honor the current tracker owner. Send a landed result or material closure blocker
once; do not also edit the same record. Update only the docs/decisions affected by
your own change. A role transfer is a live handoff that retires the old routing,
not a new long-lived tracker entry.

Report the usable result and link, a material blocker, or a changed priority.
Use evidence already obtained; the report does not need a fresh census, hash
list, PID inventory or acknowledgment chain. Name a pane and its topic only when
the recipient needs to act on that pane.

## Preserve ownership and live work

- Census and read-only triage need no approval. Dispatch is authorized when the
  user asks to lead, dispatch or harvest-and-continue; a status question alone
  is not that authorization.
- Give writers owned worktrees where the repo requires them. If a lane must
  commit in a shared checkout, tell it to load `shared-checkout`. Never remove,
  prune, rebase or force-update a worktree/branch the lane did not create.
- Close only panes you created, the user identified, or whose owner has ended
  and whose results you kept. Stop new
  dispatch when a lane is retired, preserve ignored evidence, and check its
  actual producers before closure. A separate process group or missing TTY does
  not establish independent lifetime; descendants can still die with the pane.
- Route only irreversible or outward-facing decisions to the user, batched,
  with the artifact and exact question. Verify vendor facts against first-party
  sources before using them to justify an architectural gate.
- Open optional dashboards or rearrange terminals only when requested.
