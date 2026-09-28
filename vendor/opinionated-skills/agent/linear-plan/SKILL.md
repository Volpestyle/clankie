---
name: linear-plan
description: >-
  Turn the bounded work or plan in the current conversation into dependency-shaped
  Linear issues. Use when asked to file a plan, put a plan in Linear, or "plan this
  work in Linear". Invoke as /linear-plan — it operates on the current
  conversation. Optional: /linear-plan <pane> reads a different Herdr pane's
  output instead.
---

# linear-plan

Take the plan from the current conversation — the one you just produced — and
file it into Linear's existing structure (initiatives → projects → milestones →
issues), reusing what's there before creating anything, then report the links.

This is the *plan-to-Linear* specialization. Load **`linear-issues`** before any
write for the mechanics that prevent data loss (read immediately before write,
replacement fields, pagination, and media round trips); add **`linear-write`**
when the issue text needs the user's voice. This skill adds what those don't:
pulling a plan out of a pane/conversation, and modeling cross-project work so it
scales (see "Don't squat the milestone namespace" below).

## When to use this

- You just laid out a plan / milestone breakdown / numbered TODO list in this
  conversation and the user runs `/linear-plan` to file it in Linear.
- The user says "plan this work in Linear" after establishing a bounded goal.
  Synthesize the smallest dependency-ordered plan from that context, make the
  structure visible, then file it without a separate preview gate.
- Use the bounded work already in this conversation — no need to read it from
  elsewhere.
- Optional cross-pane mode: `/linear-plan <pane>` reads another Herdr pane's
  recent output instead (see step 1b).

Not for: open-ended product ideation with no bounded goal or success condition.

## Prerequisites (discover the surface, don't assume it)

Linear tools are deferred, and the connected surface varies by harness (MCP
prefixes seen so far: `claude_ai_Linear`, `linear-server`; Codex has a bundled
Linear app). **Probe, don't recite:** `ToolSearch: +linear save issue` (or
keyword search) to find what's actually connected, and read the returned
schemas for the write convention — MCP surfaces use `save_*` as
create-*and*-update (omit `id` to create); the Codex app splits
`create_*`/`update_*`. Load list/get tools for the dedup + epic-home check in
step 3, and milestone/label/project write tools as needed.

Everything in this section is a *default to verify at use time*, not a
contract. In particular, never trust a remembered claim that a tool **doesn't
exist** — capability absences go stale silently (surfaces grow) and are
self-sealing if you believe them. When this skill says "if the surface has X",
that means: search for X now.

Workspace facts (resolve by name so it self-heals if ids change):

- Resolve the account, workspace and team from the task or repository. Verify
  the team with `list_teams` and pass it on every create.
- Projects are generic and a plan can span several (e.g. a launch touching
  `Service`, `Mobile`, `Infrastructure`). Don't assume one project.

## Linear's model (align with these official conventions)

The authority to match is Linear's conceptual model (Linear's in-product "Skills"
are a separate Linear-Agent feature, not a file):

- **Hierarchy:** workspace → team → project → milestone → issue. Initiatives are
  curated groups of *projects*. An issue belongs to exactly one team.
- **Write issues, not user stories** (Linear's own principle): a good issue is a
  concise, plain-language task. Title + status are the only required fields —
  keep descriptions actionable and don't inflate them into specs, but do carry
  the context a picker-up can't re-derive (see `linear-issues` → Issue bodies).
- **Don't squat the milestone namespace.** A milestone names a stage of *one
  project's own* work (e.g. `Beta` → `App Store submit`). A launch sequence /
  wave that spans several projects is a **cross-cutting concern** — never give
  every project a parallel set of milestones numbered to the global sequence
  (the "M0–M3 across three projects" trap). That double-books each project's
  milestone namespace, which it will need for its own phases later. Carry the
  cross-cutting sequence with a native mechanism instead: the **initiative** +
  per-wave **labels** (and project **target dates**). Each slot serves one master.
- **Labels for cross-cutting work.** Linear explicitly recommends labels for
  categories that don't fit one initiative hierarchy — that's the wave/sequence
  carrier above and the cross-project tie in step 4.
- **Cycles ≠ milestones.** Cycles are recurring time-boxed sprints; never put
  plan phases or launch waves in a cycle.
- **Initiatives need only a name and are always workspace-shared.** Tooling
  varies by surface — probe for `list_initiatives` / `save_initiative` (newer
  surfaces have full read/create); older surfaces can only *attach* projects
  via `save_project addInitiatives`, and creation may be plan-gated
  (Business/Enterprise) server-side even where a create tool exists. If no
  create path works, hand it to the user: Cmd+K → "Create initiative", then
  attach.
- **Follow the project's status workflow.** Default new work to Backlog unless
  the authorized plan calls for another state; do not assume Git automation
  exists or reserve routine authorized transitions for another approval round.

## Workflow

Order: **read first → write → summarize.** State the structure you're about to
create, then create it — no preview gate, but make the grouping logic visible.

1. **Get the plan.**
   - **Default:** use the bounded work already in this conversation. Prefer the
     most recent plan/milestone breakdown; when the user asked to "plan this work
     in Linear" before one was numbered, synthesize the minimum tasks and
     dependencies from the agreed goal. If which work is ambiguous, confirm.
   - **1b. Cross-pane mode** (only if a `<pane>` arg was passed): resolve the pane
     fresh (`herdr pane list` — ids are session-local) and read its tail with
     `herdr pane read <pane-id> --source recent-unwrapped --lines 300`. `pane read`
     wants the **pane id** (e.g. `w1:pC9`), not the label.

2. **Structure the plan, and classify its shape.** Pull out the goal, the tasks,
   and any "blocked by / must precede" ordering. Each deliverable names what the
   user can inspect, its acceptance check, delivery destination and any decision
   only the user can make. Use `linear-issues` for the result format. Keep
   implementation, proof, capture and publication under one owner; split only
   when an independent deliverable or ownership boundary requires it. Then decide:
   - **Single-project plan with stages** → those stages are that project's
     **milestones** (native, correct).
   - **Cross-project plan with waves/sequence** (tasks for several projects,
     grouped into M0–M3 / Phase N / Wave N) → the waves are a **cross-cutting
     sequence**, NOT milestones. Each task is still an issue in *its own* project;
     the wave becomes a **label** (see step 4). Don't mint per-project milestones
     for a global wave.

3. **Read first — find the home (reuse before create).**
   - **a. Survey.** `list_projects` with `team: "<verified team>"`; `list_initiatives`
     if the surface has it, else read initiatives off each project's
     `initiatives[]`. `list_issue_labels` to see existing labels.
   - **b. Map tasks to existing projects.** Match each task to the project for
     that work (clanky-ios app → `Clanky iOS`, etc.). One project for a focused
     plan; several for a cross-cutting one — file each issue where it belongs. Ask
     only if a mapping is genuinely ambiguous; otherwise state the mapping.
   - **c. Check for an existing epic/issue-tree home.** A plan that deepens work
     already tracked — an ADR's umbrella epic, a feature parent — files as that
     issue's children (`parentId`), not as freestanding issues, and wires
     `relatedTo`/`blockedBy` into the existing mechanism issues it builds on.
     Search `list_issues` (`query`, `parentId`) and `get_issue
     includeRelations` on the epic; this doubles as the duplicate check.
   - **d. New project only if nothing fits**, after confirming. Load `save_project`,
     create with `addTeams: ["<verified team>"]`, attach to a suitable existing initiative via
     `addInitiatives: ["<name>"]`, and set `targetDate` if the plan implies timing.

4. **Carry the cross-cutting concern natively** (multi-project plans).
   - **Initiative** as the container: if one fits, attach the projects with
     `save_project addInitiatives` (resolves by name, id, or URL slug). Need a
     new one? Probe for `save_initiative` and try it; if the surface lacks it
     or the API rejects (creation can be plan-gated), tell the user Cmd+K →
     "Create initiative", then attach.
   - **Per-wave labels** carry the sequence: one label per wave (e.g. `wave/0` …
     `wave/3`, or `launch:m0`), applied to every issue in that wave across all
     projects. Reuse via `list_issue_labels`, else `create_issue_label`. This is
     the cross-project rollup that does *not* touch any milestone namespace.
   - **Project target dates** can express rough wave ordering at the project level.

5. **Write — milestones (only the per-project kind), then issues.**
   - **Milestones:** `save_milestone` only for genuine single-project stages from
     step 2; reuse via `list_milestones`. Skip this entirely for cross-project
     waves — those rode labels in step 4.
   - **Issues:** `save_issue` per task — `team: "<verified team>"`, the mapped `project`, a
     per-project `milestone` if applicable, and the wave `labels` if cross-project.
     Concise title; description per `linear-issues` → Issue bodies — short when
     the task is self-evident, carrying the decision or constraint behind it when
     that's the part nobody can re-derive. Preserve order; set
     `estimate`/`priority` only if the plan states them.
   - **Dependencies:** wire ordering with `blocks` / `blockedBy` (issue
     identifiers); create the upstream issue first so you can reference it.
   - **Hierarchy:** within a single project with no milestones, a coherent plan can
     instead be one parent issue + sub-issues (`parentId`).
   - **Defaults:** Backlog, unassigned, unless the authorized plan says otherwise.

6. **Summarize + next actions.** Report the structure created — initiative / wave
   labels → project(s) → milestone(s) → issues (`TEAM-<n> — <title>` with URLs) —
   call out critical-path blockers and any next action outside the authorized
   plan. Complete authorized assignments and transitions in the same pass;
   do not turn them into another approval round.

## Gotchas

- **Milestones are per-project.** `save_milestone` needs a `project`; `save_issue`
  takes `milestone` by name or id.
- **Creating:** `team`+`title` required for an issue; `name`+a team for a project.
- **Markdown, not escaped strings.** Literal newlines in `description`, never `\n`.
- **Don't double-file.** Re-running on the same plan: check by title
  (`list_issues`) before creating duplicates.
- **Survey cheaply, then deepen.** A broad `list_projects` with many fields plus
  `includeMilestones` can exceed Linear's GraphQL complexity cap before returning
  anything. First list project ids/names/status, then `get_project` with milestones
  and resources for the selected home.
- **Auth expiry — stop, don't loop.** If Linear returns `UNAUTHORIZED:
  oauth_token_invalid_grant` / `TRIGGER_REAUTHENTICATION`, the connector needs
  reauth in the app/session — a user credential action no retry can fix. Report
  it and stop. A peer agent with a live Linear connection can file the plan on
  the blocked agent's behalf.
