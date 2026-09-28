---
name: linear-grind
description: >-
  Work the Linear queue to empty — pull every issue that is Todo or further
  along (Todo, In Progress, In Review), order it, then implement and close them
  one at a time until none are left. Use when asked to "complete our in-progress
  tickets", "work through the tickets", "clear the board", "grind the queue", or
  invoked as /linear-grind. Optional scope arg: /linear-grind <project|label>.
---

# linear-grind

Take everything in the team's active lane — **Todo and upward, not Backlog** —
and work it to done, one issue at a time, leaving evidence on each ticket.

For Linear write mechanics defer to **`linear-issues`**, and to `work-tracking`
for the lead/worker authorship rule. This skill is only the loop: build the
queue, order it, grind it, report what's left.

## Prerequisites

Linear tools are deferred and the MCP prefix varies by harness (`linear-server`,
`claude_ai_Linear`, Codex's bundled app). Probe, don't recite:
`ToolSearch: +linear issue list update status comment`. On the MCP surface
`save_issue` is create-*and*-update — pass `id` to update.

Resolve the account, workspace and team from the task or repository, then verify them with the available tools. A single visible team alone does not establish authorization.

## 1. Build the queue

```
list_issues  team: "<verified team>"  state: "started"    → In Progress / In Review
list_issues  team: "<verified team>"  state: "unstarted"  → Todo
fields: ["identifier","title","status","statusType","priority","project","assignee","url"]
```

`state` takes a **state type**, so `started` + `unstarted` is the exact meaning
of "Todo and upward" and self-heals across renamed workflow states. Backlog,
triage, completed, and canceled are out of scope — never widen to Backlog
without being asked.

Narrow by `project` or `label` if an arg was passed. Default assignee filter:
none — the whole team lane. Say which filter you used.

## 2. Order it

Closest-to-done first, so work already paid for lands before new work starts:

1. In Review → 2. In Progress → 3. Todo
2. within a tier: `priority` ascending (1=Urgent first), then oldest `createdAt`

Then fix the ordering for dependencies: `get_issue` with relations on each
candidate, and **never start an issue whose `blockedBy` is still open** — push
it behind its blocker, or drop it from the run and say so.

Print the ordered queue before starting. That list is the plan; no separate
planning pass.

## 3. Grind — per issue

1. **Read** — current acceptance criteria, decisions and evidence using
   `linear-orient`. Establish context once, then refresh changes; confirm ownership
   before claiming work another agent may already hold.
2. **Locate** — which repo/worktree does this issue live in? If it isn't the
   current one, say so and skip rather than editing a repo you weren't pointed
   at. Read that repo's `CLAUDE.md`/`AGENTS.md` before writing.
3. **Claim** — move to In Progress (or comment that you're on it, if the repo
   uses the lead/worker split — see Status below).
4. **Do the work** — normal implementation. Honor the repo's write-scope rules.
5. **Check** — satisfy the task's actual acceptance criteria and required repo
   checks. Inspect the artifact or exercised behavior; a green generic check
   does not establish a requested recording, model or gameplay result. Reuse
   valid evidence for unchanged inputs and test the relevant integration delta.
6. **Land** — follow the repo's commit, review and integration policy for source
   changes. Use its commit convention. A recording or read-only deliverable does
   not acquire a code-commit requirement merely because it has a ticket.
7. **Report with evidence** — publish the inspected result directly using
   `linear-issues`' result-update format. Reuse existing artifacts; no duplicate
   narrative from a lead or tracker. No acceptance evidence, no move.
8. **Move** — to Done (or In Review if the repo expects review), then next.

Do not batch: finish and report each ticket before opening the next. A run that
dies halfway should leave a truthful board, not five half-done tickets.

Between tickets, keep going: don't end the turn to announce the next one or ask
whether to continue — the stop conditions below are the only reasons to hand
back before the lane is empty.

## Evidence — every ticket, no exceptions

A ticket closes on its acceptance and delivery criteria. Lead with the useful
artifact and finding; keep detailed logs and provenance in a retained report
linked from the comment. A link to an expired run is not evidence:

| Change | Evidence |
| --- | --- |
| Any code | exercised behavior plus relevant check results; visible behavior also needs inspected media |
| Bug fix | the repro before, the same repro after |
| UI | a **.mov or .gif of the flow running** — screenshot only if nothing moves |
| CLI / TUI | a **.gif of the session** (`tui-demo-gif`), else the pasted transcript |
| Server / daemon | the relevant **log lines**, with the request or event that produced them |
| Perf | before/after numbers, same machine, same input |
| Data / migration | row counts or a sample record, before and after |
| Docs-only | the rendered diff or the doc link |

Rules:

- **Attribute evidence honestly.** Name the actual tested revision and scope.
  Reused evidence retains its producer, location and limitations; do not claim
  you reran it. Inspect the result and check that relevant inputs still match.
  Trim logs to decisive lines and link the retained original.
- **Motion beats a still** for anything with pixels — a .mov/.gif of the flow
  actually running is the bar. Use `demoize` (web, iOS, RN, Tauri → deterministic
  MOV/GIF bundle), `tui-demo-gif` for terminal UIs, `run` or `ios-simulator` to
  just launch and grab a frame. Fall back to a screenshot only for a static
  change; say why there's no clip.
- **Attach files, don't describe them.** Screenshots, logs, profiles →
  `prepare_attachment_upload` (issue, filename, contentType, size) → `PUT` the
  raw bytes to `uploadRequest.url` sending **every signed header verbatim**
  (60s expiry, one file at a time) → `create_attachment_from_upload` with the
  returned `assetUrl`. Then reference it from the comment.
- **Couldn't get evidence?** That's a stop condition, not a footnote — say what
  blocked it (no device, no ROM, needs the user) and leave the ticket open.
- Big verification campaigns that outgrow a comment belong in a repo record —
  see the `testing-archive` skill — with the link posted on the ticket.

## Status: who moves it

Use `work-tracking`'s delegated-authority rule. Workers can complete transitions
authorized by the project's workflow; where that workflow reserves them for a
lead or automation, leave them with that owner. A role title alone does not
establish the policy. Check before the first move, not after.

## Stop conditions

Stop the loop and report — don't improvise past any of these:

- **Needs the user** — physical/on-device check, a credential, a product decision.
  Assign to the user’s verified tracker account, make the human step an acceptance criterion,
  comment what's needed, move on to the next ticket.
- **Acceptance criteria are ambiguous or contradict a repo ADR** → comment the
  conflict and the smallest decision needed, skip the ticket.
- **The only fix weakens a test or a trust boundary** → skip, comment why.
- **Auth expiry** (`UNAUTHORIZED: oauth_token_invalid_grant`,
  `TRIGGER_REAUTHENTICATION`) → stop entirely. The connector needs reauth in the
  app; no retry fixes it, and re-running burns turns.

Skipping is a normal outcome. Silently doing a different, easier thing is not.

## 4. Finish

Report a table: identifier · title · outcome (done / in review / skipped +
one-line reason). Then the residue — what's still open and what each one needs.
If everything closed, say the lane is empty.

## Gotchas

- **`state` filter takes a state *type*** (`started`, `unstarted`, `backlog`,
  `completed`, `canceled`) or a literal name. Use the type — workflow state
  names get renamed, types don't.
- **Don't widen to Backlog.** Backlog is unprioritized by definition; grinding
  it is a different, larger decision that's the user's to make.
- **Re-running is fine** — the queue is rebuilt from live status each run, so
  closed tickets simply drop out. Don't keep a local list across runs.
- **One issue at a time in one worktree.** Parallel fan-out across panes is
  `herdr-lead`'s job, not this skill's.
- **Every reported outcome points at inspected evidence** — a fresh tool result
  or an explicitly attributed retained proof whose relevant inputs still match.
  Verify current delivery and status; report missing steps honestly.

## Related skills

- `work-tracking` — lead/worker authorship, assigning work that needs the user.
- `linear-plan` — the other direction: file a new plan as issues.
- `demoize` / `tui-demo-gif` / `run` — produce the clip the evidence rule wants.
