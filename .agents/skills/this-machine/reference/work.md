# Leading work across turns

Long-horizon work on wakes, lead review rounds, watching workers, cost evidence, showing current work, service goals, tidying, and project onboarding and membership.

## Long-horizon work without a goal

Overnight or all-day work does not need a service goal, and a native harness
seat cannot hold one (`create_goal` refuses with `native_goal_unsupported`).
Carry it across turns on wakes instead:

| Wakes you when                    | Source                                     | Limits                                                                                  |
| --------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| A worker finishes, blocks or asks | its `message_clankie` report               | only workers that report; read with `worker_reports`                                    |
| A watched pane settles            | `herdr_watch SEAT`                         | one-shot; arm it again after each wake                                                  |
| Owned seats need review           | the periodic fleet round, every 30 minutes | only while this conversation owns live seats; skipped when nothing changed              |
| Someone acts on a tracked issue   | signed Linear activity                     | eligible activity only, to the configured chat; your own activity does not wake you     |
| A time you chose                  | `schedule_wake(at, reason)`                | one pending wake per conversation, and a new one replaces it; only while autonomy is on |

The loop: keep the objective, done criteria and boundaries in the tracker issue
or a handoff file, because a wake starts from the conversation, not from a fixed
goal. On each wake, harvest what changed, land or redirect, and assign the next
ready item in tracker order. Before ending the turn, check that one of the sources
above will fire. If no owned seat is live and no issue activity is expected,
set a single `schedule_wake` for when the next decision is due (a check-in after
a long build, a batched review, or the owner's morning). Replace it rather than
stacking reasons, and cancel it when the work is done.

Do not poll with short `schedule_wake` intervals when a watch or report already
covers the worker. Do not start a second lead in another conversation to get
continuation. Do not use a harness's own scheduler (Claude Code `/loop` or cron
tools, Codex `/goal`) to keep the lead going: it is tied to one native session,
and the owner's `/autonomy off` does not reach it. A worker may still use its
harness's goal for its own ticket. `/autonomy off` stops wakes and goal turns;
when it is off, tell the owner what is left open instead of working around it.

## Lead review rounds

For every watch wake and periodic lead round (30 minutes by default), load
`lead` and inspect every seat owned by this conversation. Use
`clankie agents efficiency --conversation ID` or `fleet_efficiency` with
`action: "show"`; the roster and agent dock carry plain efficiency flags.
Periodic checks skip a model turn for unchanged, unflagged evidence and coalesce
while a review turn is outstanding. Wake prompts carry
bounded summaries; use the tool or CLI for the full owned roster. Context
percentage is the latest native Codex model-input snapshot and may age between
responses. Claude context/effort and OpenCode or remote telemetry remain unknown.
Original report acceptance or attempt remains progress after acknowledgment;
acknowledgment creates no new progress. Automatic commit evidence requires the
seat's captured branch and exclusive linked worktree, with HEAD advanced since
admission; primary or shared checkouts do not count. Ask the worker or re-hire to
change its effort. Record inspected
scope, tracker status or substantive progress with
`clankie agents efficiency review SEAT --conversation ID --json-stdin`;
the JSON requires `evidence` and optionally accepts `offScope`,
`assignmentStatus`, `deliverable` and `progressAt`. The tool's `review` action
records the same evidence for an exact owned native session. It changes no
tracker state, ownership, harness settings or report receipts. Follow the
`lead` skill for action and worker-report reconciliation.

## Watching workers

The local console stays in the current terminal. Its two-line live-agent dock
below the prompt uses the service fleet feed across connected machines.
`Ctrl+G` opens the full scrolling agent modal; Up/Down selects, Enter opens a
worker's existing conversation, and Escape closes the modal without losing the
draft. Escape from the worker conversation returns and leaves its work running.
`Ctrl+Y` from that conversation opens the exact pane in the selected machine's
Herdr workspace. It attaches to an existing server, never starts one. `/agents`
also retains past agents with saved threads. Do not treat a visible working
state or a successful workspace focus as a delivery receipt or model-seen proof;
messages still use native delivery and unconfirmed sends must not be retried
blindly.

## Cost and effort evidence

Issue-only metrics stream assignment discovery in exact bound histories before
loading matching sources; unrelated histories cannot exhaust their full-read budget.
Coverage warnings still identify oversized, unavailable and ambiguous sources.
For accepted-issue cost evidence, use `clankie metrics --issue ISSUE --since ISO
--until ISO` or `clankie metrics --issues --worker LABEL`. The operator route
projects retained native history and existing ledgers. Exact local bindings in
conversation metadata, hire-owner records, and archived pane-tidy entries also
cover older workers and closed panes. A session retained in several records or
as both an ID and transcript path is counted once; `--worker` accepts its
retained label, seat ID, session ID, or transcript path. Missing, remote,
malformed, conflicting, or ambiguous bindings remain explicit coverage gaps. This read
does not search unbound histories, alter ownership, or grant delivery authority.
Report its `coverage`
alongside token, wall-time, check and rework totals: parent native usage is
partial, elapsed time includes waits, and a passed seat edge is not approval.
Unknowns remain null; never turn missing history into a zero-cost claim. See
`docs/cli.md` under `repoRoot` for window and attribution rules.

## Showing current work

A local agent can state its current assignment with `clankie work-on "Objective"`
from its own Herdr pane. Add `--repo REPO_ID --issue ISSUE_ID` to link the exact
registered repo and its existing tracker item; use `clankie work repos` to find
repo IDs. Clear the pointer with `clankie work-on clear` when it no longer
applies. This changes display metadata, not the issue's status or ownership.
The pointer follows the native session through a pane move and service restart;
a new session does not inherit it. Keep transient actions in `clankie stance`
notes. Local Codex `/goal` state appears automatically, including paused,
blocked, budget/usage limits and completion. Remote or unsupported native goal
stores remain unknown. Goal state and busy/idle turn status are independent.

`stance` moves your own figure in the commons and takes no seat argument — it resolves
`HERDR_PANE_ID` against the live census, so it can only move the figure you are
sitting in. `--for` defaults to 15 minutes, caps at an hour, and then lapses
back to observed behavior. `{"outcome":"unseated"}` means this pane holds no
fleet seat — normal in a plain shell, not an error.

For the World work-kind bubble, read `seat.activity.kind` from roster/fleet;
`source` distinguishes a native tool observation from an expiring agent statement.
Never derive it from `doing`, a note or shell command text. Use `clankie stance
working --activity testing --for 60` to state work a generic shell cannot describe.
A replacement stance without `--activity` clears it; an idle/offline seat or a
changed occupying session has no activity. Unknown means no bubble.

## Service goals

Service goals require a Pi-owned conversation. Pi's `create_goal` stores an
inactive proposal for the owner to confirm with `/goal accept`; only owner
commands activate it. Native harness MCP seats refuse service `create_goal`
with `native_goal_unsupported`, since the service cannot enforce their goal
continuations or usage. Every service goal has a finite token budget (default
1,000,000; owner override `/goal --tokens <n> <objective>`), including restored
goals. A refused native goal is a boundary to explain, not a cue to start a
second lead through another conversation.

Starting, accepting or resuming service goals and enabling autonomy require the
owner/device transport; the ambient captain bearer receives `goal_owner_required`
(HTTP 403). Owners may also use `clankie conversations goal ID accept|resume` or
`clankie conversations goal ID set --tokens N <objective>`. This separates API
authority, not local OS identities: a same-UID shell can still read the operator
credential or device signing key. See ADR 0130 for that remaining boundary.

## Tidying worktrees

When tidying, load `tidy` and list remaining merged, clean worktrees with
`clankie agents tidy-worktrees --repo /canonical/repository/path
[--merged-into REF]` or `list_tidy_worktrees`. Listing does not remove anything
or fetch refs; the default ref is `origin/main`. Main, dirty, unmerged, locked,
prunable and live-pane worktrees are excluded. An incomplete pane census returns
no candidates. Verify ownership and fresh landing evidence before removing an
owned worktree, after keeping its results. Full contracts: `{repoRoot}/docs/cli.md`.

## Project onboarding and membership

For an unassigned owner workspace conversation, read the repo and its existing
work convention, then use dialog questions for tracking, useful project roles
and fleet size (`solo`, `small`, `large`, `max`). `propose_project_create` offers
the existing explicit CREATE review; preference answers alone authorize no
write. A missing convention can be proposed as `trackerSetup` using work-init
inputs and `trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" }`.
It initializes tracking only on explicit CREATE. After uncertainty, read that
same proposal target; do not repeat CREATE. The tracker may have saved before
the project settings failed. No provider project, label or account is created.

Hires keep their recorded project/role assignment independent of cwd. Agents
Clankie did not start use verified native cwd in an enrolled project workspace
or a verified linked worktree; roster cwd and persona identity are not authority.
The owner membership API observes local and registered Windows fleet seats,
rechecks native identity before publication and leaves missing or ambiguous
proof unscoped. An unconfirmed hire never falls back to cwd assignment.
Project membership does not restrict connected tools: every admitted pane in a
Clankie-linked session uses the connected catalog under ADR 0217.

Retire a workspace explicitly with `clankie project remove-workspace NAME
--workspace PATH`, even if its directory is gone. This preserves roles, caps,
grants and assignments; a tracker-bound workspace must first have its tracker
binding moved or removed. Missing/noncanonical local registrations match nobody
without denying unrelated valid workspaces. For remote approval/removal append
`--machine FLEET_ID --platform windows|posix` and use that machine's exact absolute
path. An approval is never remote process proof or a tool grant.

## Repository-bound worktree roots

An owner may enroll a dedicated root for a repo's future linked worktrees:
`clankie project add NAME --worktree-root ROOT --repo APPROVED_REPO`.
The repo must already be an exact approved workspace in that project. Add
`--machine ID --platform windows|posix` for a registered remote machine.
The service proves canonical paths and native Git registration; a root is never
ordinary folder-containment authority. This changes project membership policy,
not tool grants. Do not run it as a workaround for an unapproved workspace.
Remove only the enrollment with `clankie project remove-worktree-root NAME
--worktree-root ROOT` and the same machine/platform flags. Remove root enrollments
before their repo workspace. Neither command deletes filesystem content.
