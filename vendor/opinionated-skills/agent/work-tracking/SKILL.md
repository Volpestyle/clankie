---
name: work-tracking
description: >-
  How to use an issue/work tracker when one is actually in play — which tracker
  to use, how to assign work that needs the user, the lead/worker authorship model
  for multi-agent work on a shared tracker, and using the tracker as a diagnostic
  input when investigating bugs. Engage only when work-tracking is genuinely in
  scope (creating/updating issues, tasks, projects, planning, status updates,
  assignment, multi-agent coordination, or checking existing tickets/WIP during a
  bug hunt) — this is deliberately not always-on. Linear MCP is the available
  tracker tool but never the assumed default.
---

# work-tracking

Standing preferences for working with an issue/work tracker. These apply **only
when work-tracking is actually happening** — they are not a default that switches
tracking on. If no tracker is specified for the task or repo, don't reach for one.

## Which tracker

- Use the work-tracking system the user or repository specifies for tasks,
  issues, projects, planning, and status updates. Don't assume a particular
  tracker if none is specified.
- Linear MCP is available as a tracker tool (registered in the Claude/Codex
  config), but it is not a global default — only use it when the user or repo
  names Linear, or a Linear workspace is clearly the tracker already in use.
- On a machine running Clankie, `clankie work` (its `work-items` skill) discovers
  where a repo tracks work and reads and writes it the same way for every
  backend. Use it for the mechanics; this skill carries the standing
  preferences, and `linear-issues` the Linear-specific formatting.

## Assigning work that needs the user

- When a tracked task needs the user specifically — human or live verification,
  an on-device/physical check, a decision only they can make, or
  access/credentials only they hold — assign that item to the user's own
  tracker account and make the human-needed part an explicit acceptance
  criterion, rather than leaving it unassigned or self-assigning.

## Lead / worker authorship on a shared tracker

- Follow the user's delegation and the project's workflow. The lead owns scope,
  priorities and assignment boundaries; workers publish their own results and
  evidence directly, without a tracker or lead rewriting the same handoff.
- Workers may perform status transitions authorized by that workflow when the
  evidence meets the acceptance and delivery criteria. Shared integration,
  disputed acceptance, scope expansion and tracker restructuring go to their
  decision owner. A project that reserves transitions for its lead keeps that rule;
  a single agent working alone holds both responsibilities.
- Keep current scope, decisions and the latest result discoverable on the issue.
  Publish meaningful results, changed decisions and actionable blockers, not an
  implementation diary. For Linear, `linear-issues` owns the result-update format
  and media mechanics. Local pane and queue coordination stays in the live handoff.

## Tracker as a diagnostic input

- When investigating a bug, treat the work tracker as a diagnostic input: before
  deep-diving the code, search in-progress and recently-closed tickets for the
  same symptom or a change that could have caused it — the defect may be a known
  in-flight ticket or another agent's WIP rather than a fresh bug. Read those
  threads before forming a hypothesis.

## Related skills

- `linear-plan` — file a plan you just produced into Linear's structure.
