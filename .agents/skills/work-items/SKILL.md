---
name: work-items
description: >-
  Use when you create, update, close, or report on tracked work in a repo on
  this machine: tasks, issues, acceptance criteria, or the evidence behind a
  result. Tracks work where the repo already does (Linear, GitHub issues, its own
  Markdown directory) and in .clankie/work/ only when it has nothing.
---

# Work items

Track work where the repo already tracks it. Never impose a tracker on a repo
that has one (ADR 0191). Use tracking only when the user or project workflow
calls for it; an available tracker is not a reason to create ceremony.

## The contract

`clankie work` is the same for every agent here, whatever the backend. Run it
from inside the repo (or pass `--repo PATH`); output is JSON.

| Need                           | Command                                                       |
| ------------------------------ | ------------------------------------------------------------- |
| How does this repo track work? | `clankie work` (discover: signals, convention, or a question) |
| Record the answer once         | `clankie work init` (discovered) or `init --backend B ...`    |
| What is open?                  | `clankie work list --status todo,in_progress`                 |
| One item                       | `clankie work show ID`                                        |
| New item                       | `clankie work create "Title" --criterion "..." --owner NAME`  |
| Progress                       | `clankie work update ID --status in_progress --check 1`       |
| Finished                       | `clankie work close ID` (`--canceled` if dropped)             |
| Evidence                       | `clankie work attach ID --url URL --caption "what it proves"` |

Statuses: `todo`, `in_progress`, `in_review`, `done`, `canceled`. Criterion
numbers are 1-based. Clankie himself has the same contract as the `work_items`
and `work_item_write` tools.

## Rules

1. **Discover before creating.** If `clankie work` returns a `question`, the
   repo tracks work in more than one place or only in a single `TODO.md`. Ask
   the owner (or your lead) once, then record the answer with
   `clankie work init --backend ...`. Never pick silently.
2. **Follow what is recorded.** `.clankie/tracking.json` is the owner's answer.
   Do not create `.clankie/work/` files in a repo whose convention is Linear,
   GitHub or its own directory.
3. **Every result carries evidence.** Before you report something finished,
   attach inspectable artifacts: a screenshot or short video for anything
   visible; the decisive test output, numbers, and commit links for anything
   headless. Caption each with what it proves and what is sample data or a
   stand-in. Large media belongs in an artifact store; attach the link.
4. **One owner per item.** Set `--owner` when you take an item; do not edit an
   item another agent owns without telling them.
5. **Keep it small.** Status, criteria, ownership and evidence only. No sprints,
   estimates or extra workflow.

## Ownership and useful updates

When work needs the user specifically (a decision, credentials, a physical or
live check), assign that item to their tracker account and make their part an
explicit acceptance criterion. The lead owns scope and assignment boundaries;
workers publish their own results and evidence directly, following the project's
rules for status transitions. Shared integration, disputed acceptance and scope
changes go to their decision owner. Keep the latest scope, decisions, result and
actionable blockers on the issue; keep live coordination in the handoff.

For a bug investigation where a tracker is in use, search in-progress and recent
closed items for the symptom or related changes before forming a code hypothesis.
Use `linear-issues` when available for Linear-specific formatting and attachments.

## When the backend is unavailable

`backend_unavailable` names the recorded convention: Linear or GitHub is not
connected to Clankie (`clankie accounts`), or `gh` is signed out. Report that to
your lead. Do not fall back to
files, which would fork the record.
