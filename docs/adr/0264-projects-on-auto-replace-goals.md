# ADR 0264: Projects on Auto replace goals

Status: accepted by the lead for VUH-2029, 2026-10-10.
Tracked by [VUH-2029](https://linear.app/vuhlp/issue/VUH-2029). Builds on
[ADR 0263](0263-one-autonomy-dial-over-the-decision-leaves.md) and
[ADR 0216](0216-projects-own-agent-roles-and-tool-policy.md); supersedes the
owner-facing goal flow of [ADR 0130](0130-goals-and-self-wakes-share-the-operator-thread.md).

## Context

The owner assigns Clankie projects and expects him to work them without being
told or babysat. The only way to ask for that was `/goal`. Goals are scoped to a
conversation and spend against a token budget, and native harness seats refuse
them ("Goals are unavailable"), so the head seated in Claude Code or Codex
could not hold standing work at all. Docs taught `/goal accept` to owners whose
seat would refuse it.

## Decision

Two owner controls, separate from the autonomy dial:

- **Auto, per project.** `auto: true` and an optional one-line `focus` (at most
  280 characters) are project settings, written through the existing
  revision-fenced project update. The `?includeAutonomy=true` snapshot carries
  them and advertises `projectsAuto: true`; the plain view strips them, as it
  strips `trackerProjectId`, so older strict clients keep parsing.
- **The master switch.** `clankie auto on|off` and the console's `/auto` are
  the existing global autonomy runner switch in
  `~/.clankie/captain/autonomy.json`. Off stops projects on Auto, goal runs and
  scheduled self-wakes together, and the switch still reads as off when its
  file cannot be read. Turning it on still needs the owner credential.
  `/autonomy pause|resume` folds into `/auto`.

**The Auto round.** On the fleet-round cadence (30 minutes), while the master
switch is on and any project is on Auto, the service wakes Clankie's head
conversation with every Auto project's name, focus, bound tracker project and
live workers in its local workspaces and worktree roots. Unchanged evidence
rewakes after two hours, not every round, so an idle or blocked project costs
one turn every two hours, not one every half hour. It is an ordinary wake:
a native seat holding the head receives it as it receives any other, and it
grants no tool or authority. Staffing stays inside each project's worker cap
and role policy (ADR 0216) and the machine and account limits (ADR 0261). The
dial decides which calls he makes alone.

There is no token budget to set; account headroom already bounds hiring.

**Goal code.** The goal store, `/goal`, `clankie conversations goal` and the
model's goal tools stay for now and are no longer taught. They are removed in
a follow-up once two projects on Auto have run unattended with evidence (the
VUH-2029 live proof). `schedule_wake` stays: it is how he carries long work
between rounds.

## Consequences

- The head conversation leads every Auto project. A project with its own lead
  chat or remote project lead (ADR 0259) is still woken through the head;
  routing the round straight to a project's lead is a later change.
- Worker counts come from local seat directories. Remote workspaces count
  through their own lead.
- The projects view status line (agents working, landed today, needs-you
  count) and the app's Auto controls are follow-up slices on this API.
  (2026-10-10: the status line reads live seats, commits on each local
  workspace's fetched origin branch since local midnight, and pending owner
  questions by workspace. Asks raised in the head have no workspace, so the
  view also counts every pending owner question.)
