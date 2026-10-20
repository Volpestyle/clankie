# Long-horizon work

How [lead](../SKILL.md) carries work across turns: what wakes it, standing work
on Auto, and what an Auto round's signals ask for. Three controls are distinct:
the `clankie auto` master switch gates self-wakes and Auto rounds; the autonomy
dial (`clankie autonomy`: `off`, `low`, `high` by default, or `full`) sets which
decisions you take without asking, and its effective gates arrive in "Your
fleet"; a project on Auto (ADR 0264) hands you its backlog as standing work.

## Wakes

| Wakes you when                    | Source                                     | Limits                                                                                                      |
| --------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| A worker finishes, blocks or asks | its `message_clankie` report               | only workers that report; read with `worker_reports`                                                        |
| A watched pane settles            | `herdr_watch SEAT`                         | one-shot; arm it again after each wake                                                                      |
| Owned seats need review           | the periodic fleet round, every 30 minutes | only while this conversation owns live seats; skipped when nothing changed                                  |
| Someone acts on a tracked issue   | signed Linear activity                     | eligible activity only, to the configured chat; your own activity does not wake you                         |
| A time you chose                  | `schedule_wake(at, reason)`                | one pending wake per conversation, and a new one replaces it; only while the master switch is on            |
| A recurring time                  | `routine` (`clankie routines`)             | runs on its schedule until paused or removed; never overlaps or repeats a slot                              |
| A project is on Auto              | the Auto round, on the fleet-round cadence | the project's configured lead chat, else the global head; on changed evidence or every two hours; switch on |

Keep the objective, done criteria and boundaries on the work item (the handoff
protocol is in `work-items`), because a wake starts from the conversation, not
from a fixed goal. On each wake, harvest what changed, land or redirect, and
assign the next ready item in tracker order. Before ending the turn, check that
one of these sources will fire. If no owned seat is live and no issue activity
is expected, set a single `schedule_wake` for when the next decision is due (a
check-in after a long build, a batched review, or the owner's morning). Replace
it rather than stacking reasons, and cancel it when the work is done.

Do not poll with short `schedule_wake` intervals when a watch or report already
covers the worker. Do not start a second lead in another conversation to get
continuation. Do not use a harness's own scheduler (Claude Code `/loop` or cron
tools, Codex `/goal`) to keep the lead going: it is tied to one native session,
and the owner's `/auto off` does not reach it. A worker may still use its
harness's goal for its own ticket. `/auto off` stops the Auto round and wakes;
while it is off, tell the owner what is left open instead of working around it.
A wake whose turn fails three times, or once with a rejected model credential,
is held, not retried, until your seat binds or the service restarts.

## Standing work on Auto

The Auto round names the projects on Auto, each with an optional one-line focus;
work their backlogs without waiting to be asked, within each project's worker
cap and the autonomy dial, and bring the owner only the decisions the dial
leaves to them. A project not on Auto gets no new work you start yourself.

Auto rounds go to the existing configured lead chat owning the bound tracker
project, even when that chat uses a different workspace. A lead assigned to
another project never takes work by workspace matching; only unassigned leads
may match that way. Absent or ambiguous ownership goes to the global head.
Leads hear only their own Auto projects and wake independently when their
evidence changes or after two hours idle. No separate Auto routing setting
exists. Each round names its signals and the action it asks for; the sections
below explain what the follow-up checks prove. Measurements: `clankie auto rounds`.

## Drift corrections

When a round names drift, choose the next milestone feature and staff it; for
excess WIP, choose which issues to return to Backlog and note where they
stopped. Record the feature issue and one-line reason with
`record_drift_correction`, using the `projectId` and `roundId` in that wake. The
tool records the decision; it does not start an issue or hire anyone. It accepts
only Auto projects owned by this conversation and retains exact retries. A new
choice belongs to a later round.

The next round checks the named issue reached a started state and product churn
landed after the response. Unresolved means correct course again; unknown means
the service could not read a source, not success. Product churn is project-wide
evidence, not proof that the chosen issue caused it.

## Staffing

`under_staffed` means ready unblocked work, spare capacity under the project
caps, and fresh plan headroom coexist: staff independent ready results in that
round, reusing suitable idle owned seats or hiring within ordinary admission.
Owner-blocked items hold only their named dependent issues; keep their blocker
edges current and continue unrelated ready work.

`backlog_not_ready` asks you to break backlog items into ready results rather
than idle while plan capacity remains. The next round checks active staffing
increased, or records `cap_reached`, `no_ready_work` or `plan_reserve`. An
unresolved check needs action again; unknown telemetry is not spare capacity.
Re-read usage before a hire. Detection does not grant authority, change caps,
pick an issue or start a worker; those remain your decisions.

A board reset can return finished work to Backlog. Before staffing a Backlog
item whose history shows a review or verifying stage or a linked commit, check
the destination branch for its landed fix, and close it with that evidence
instead of re-staffing it.

## Milestone reports

A newly completed parent issue or declared tracker milestone asks for exactly
one project status update with media and evidence links; cover milestones found
together in that one post. Read the previous update, show useful media, and link
completed issues and their retained evidence. Routine rounds request no project
update; keep routine progress on the issue. Reconcile uncertain status-update
writes: a missing reply, a service restart or an unsettled round never
authorizes another post. The next measurement links the observed update to the
original request and flags routine or excess posts.

Auto's check deadline and each lead's delivery fence survive service restarts;
a paused master switch still prevents work.
