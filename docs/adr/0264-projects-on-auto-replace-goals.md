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

**Service-lane staffing (2026-10-12).** The live two-project window found that
an offline native lead could execute its Auto round in the service lane, but
`hire_agent` unconditionally refused autonomous turns (builtin LOCAL-VUH-6).
An autonomous service turn may now hire through the ordinary native path only
when the master switch is on, the owner's saved global autonomy is Full, and
the resolved project is on Auto. Project overrides must still allow everyday
and outward work and lead-owned machine setup. A project release override does
not change this hiring permission. Policy and original conversation authority
are reread at native admission boundaries; the existing project/role caps,
machine admission, account holds, checkout and delivery fences still apply.
Other autonomous turns retain the propose-only refusal with its reason.

There is no token budget to set; account headroom already bounds hiring.

**Goal code.** The goal store, `/goal`, `clankie conversations goal` and the
model's goal tools stay for now and are no longer taught. They are removed in
a follow-up once two projects on Auto have run unattended with evidence (the
VUH-2029 live proof). `schedule_wake` stays: it is how he carries long work
between rounds.

(2026-10-10: removed after the live proof, run on one project by the lead's call. `get_wake` replaces `get_goal` as the
model's read of the switch and its pending wake. An `autonomy.json` that still
holds a goal loads with its switch and wakes, and the goal is dropped on the next
save; `goal-journal/` is no longer written. Native Codex thread goals are the
harness's own and still show on fleet seats.)

## Consequences

- The head conversation leads every Auto project. A project with its own lead
  chat or remote project lead (ADR 0259) is still woken through the head;
  routing the round straight to a project's lead is a later change.
  (2026-10-12, VUH-2029: rounds now use the existing configured lead chats when
  exactly one chat matches a project's workspace and machine. Otherwise they
  fall back to the global head. Pending rounds and idle suppression are per
  lead; round admission rechecks the master switch, group membership and evidence.)
- Worker counts come from local seat directories. Remote workspaces count
  through their own lead.
- The projects view status line (agents working, landed today, needs-you
  count) and the app's Auto controls are follow-up slices on this API.
  (2026-10-10: the status line reads live seats, commits on each local
  workspace's fetched origin branch since local midnight, and pending owner
  questions by workspace. Asks raised in the head have no workspace, so the
  view also counts every pending owner question.)

### Routing correction, 2026-10-12

The live VUH-2029 preflight found Clankie Work's configured project lead chat
using the clankie workspace while its project workspace was tracker-research.
Workspace matching reversed the two projects' leads. Explicit bound tracker
project ownership now wins regardless of workspace. Workspace matching can
select only a lead with no configured projects, never another project's owner.
Ambiguous or absent ownership falls back to the global head.

### Separate Linear reference, 2026-10-12

`trackerProjectId` keeps its built-in meaning and consumers. An optional
`linearProjectBinding` holds `{provider: "linear", projectId: UUID}` separately.
The owner project API validates it directly through the connected Linear app,
with no local fallback. Failed validation leaves settings unchanged. A plain
snapshot omits it; the autonomy-aware view advertises `linearProjectBindings`.
Bind/clear starts with the CLI and TUI, with app controls in the next slice.
Auto wakes include both provider references and explicit routing recognizes
either UUID. The saved repo tracker convention still decides its backend.

### Configured ownership also governs hires, 2026-10-12

`LOCAL-VUH-7` exposed a second workspace attribution error: the Work lead's
conversation used the clankie folder, so its hire into the registered
tracker-research folder was refused as cross-project. Hire source attribution
now honors the same explicit built-in/Linear project lead binding as Auto
routing. A configured lead cannot fall back to another project's folder, and
multiple owned projects require an explicit `projectId`. Destination membership,
native identity, role and cap checks, machine and account governors remain in
force; saved ownership is re-read before native effects.
