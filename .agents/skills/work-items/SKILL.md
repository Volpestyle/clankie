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
| One role's backlog             | `clankie work list --label designer` (case-insensitive)       |
| One item                       | `clankie work show ID`                                        |
| New item                       | `clankie work create "Title" --criterion "..." --owner NAME`  |
| Progress                       | `clankie work update ID --status in_progress --check 1`       |
| Finished                       | `clankie work close ID` (`--canceled` if dropped)             |
| Evidence                       | `clankie work attach ID --url URL --caption "what it proves"` |

Statuses: `todo`, `in_progress`, `in_review`, `done`, `canceled`. Items carry
the backend's `labels` (Linear, GitHub, or Markdown `labels:` front matter);
label an item with a role name (`designer`, `builder`, …) to put it on that
role's station in the owner's world. Criterion numbers are 1-based.
Clankie and workers use the same `linear_*` tracker tools, discovered through
`mcp_tool_search` or `clankie_tools` and called through the corresponding tool
directory. Their issue, comment, project and status-update shapes work with
owner-connected Linear or durable local storage. A `repo` selects an existing
repository convention; GitHub and Markdown are adapters to that same surface.
`clankie work` remains a compatibility CLI. `clankie doctor` reports the active
backend and why it was selected. Follow `linear-orient` and `linear-issues` for
the shared read/write shapes on either backend; a local identity is visibly local.

Priority is `0` (none), `1` (Urgent), `2` (High), `3` (Medium), `4` (Low).
Issue writes accept `priority`; `clankie work create` and `update` accept
`--priority 0..4`. Open-work lists sort Urgent through Low, then unprioritized,
before limiting or paginating. Local identifiers remain stable across restart.

When the owner's Linear convention uses an existing repo label, record it with
`clankie work init --backend linear --linear-team KEY --linear-project NAME
--linear-label LABEL` (the project is optional), or `linearLabel` on
the compatibility HTTP init request. This saves `linear.label` in the convention.
The board then includes only issues with that label; `list --label designer`
intersects it with the role, status and owner filters. New items carry the saved
label. Omitting the saved label keeps the existing team/project-wide board;
direct `show ID` reads are unchanged. Choose an existing label under the owner's
authorization; the command never creates labels or selects another account.
Edits and attachments keep existing labels and uploaded media; an ambiguous
Evidence heading is refused rather than replaced.

During conversational project onboarding, a missing convention can be included
in `propose_project_create` as `trackerSetup` with these same explicit work-init
inputs. The existing CREATE review covers both tracker initialization and the
project config. Preference answers do not write either. An existing convention
must be read and reused; initialization refuses to replace it. A partial failure
may leave a saved tracker without a project, so reconcile the original proposal
rather than repeating confirmation.

## Rules

For an existing project's team settings, `clankie project list` returns the
current revision. `clankie project update PROJECT --changes FILE.json --revision
REVISION` changes only the reviewed name, roles, worker cap or tracker binding;
`/project` exposes the same commands in the console. Follow explicit task or
owner authorization before changing those settings. A tracker binding points
to an already enrolled workspace's existing `.clankie/tracking.json`; it does
not initialize tracking or choose a connected account. The app reads local
bindings through project repo references. Remote or missing sources
remain unavailable, never a reason to select another local repo or backend.

Owner-authorized devices with `terminalControl` can set work metadata owner,
add/remove a role label, or append a prerequisite using `work_item_write`.
`clankie work write ID --owner NAME|--no-owner|--add-label ROLE|--remove-label
ROLE|--add-blocker ID` uses the same narrow receipt path. It returns a
`requestId` and `applied`, `refused`, or `uncertain`. Keep the ID; use
`clankie work receipt ID --request-id UUID` or `work_item_write_receipt` after
uncertainty. Never resend the change with a new ID. This path requires a saved
local tracker and connected provider account; it preserves unrelated labels
and prerequisites. Broader agent updates retain the existing CLI and tools.
Items may have an optional backend-native `parent`; it groups work and does
not imply a prerequisite.

1. **Discover before creating.** If `clankie work` returns a `question`, the
   repo tracks work in more than one place or only in a single `TODO.md`. Ask
   the owner (or your lead) once, then record the answer with
   `clankie work init --backend ...`. Never pick silently.
2. **Follow what is recorded.** `.clankie/tracking.json` is the owner's answer.
   Do not create `.clankie/work/` files in a repo whose convention is Linear,
   GitHub or its own directory.
3. **Prefer real visuals; every result carries evidence.** When creating,
   planning, updating or reporting tracked work, default to useful visuals:
   screenshots or short clips of tangible results, charts of measured data,
   and diagrams grounded in the actual system, dependencies or flow. This
   applies to headless work too. Inspect visuals before attaching them; caption
   what they show, their source or revision, and what they establish. Label
   proposals, sample data and unverified states clearly. Before reporting work
   finished, attach inspectable evidence, with decisive test output, numbers
   and commit links supporting the result. Reuse meaningful artifacts; when
   no visual adds information, use the decisive evidence without decorative
   filler. Large media belongs in an artifact store; attach the link.
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
actionable blockers on the issue; keep live coordination in native fleet messages.

For a bug investigation where a tracker is in use, search in-progress and recent
closed items for the symptom or related changes before forming a code hypothesis.
Use `linear-issues` when available for Linear-specific formatting and attachments.

## Linear worker results

With a verified Clankie Linear app connection, publish a worker's result using
`linear_create_worker_comment` (or `clankie linear post comment --json-stdin`
from the operator seat), with its existing fleet `personaId`, `issueId` and
`body`. The service derives the worker's name and colored portrait. This is one
app identity, not an email alias or a separate Linear member. A worker bridge
grant must pin the exact `personaId`; without that grant, send the result to
the lead to publish. Never substitute an inherited personal tracker connector.

A worker reports through `message_clankie` to its hiring/adopting conversation:
outcome, branch and commits, checks, evidence links, unresolved gaps and open
decisions. Peer collaboration uses `list_fleet_seats` / `message_peer` when
exposed; it does not replace the lead's outcome report. Return that same short
final report at turn completion. Leads start from that report and evidence and open the retained
thread only when needed. Keep routine coordination out of issue comments.
For setup and supported paths, read `docs/linear-worker-posts.md` in Clankie's
repository or the worker-posts section of the CLI reference.

## When the backend is unavailable

When Linear is not connected, the same tools select durable local storage.
Read `clankie doctor` for the active backend and reason; local records do not
automatically migrate when Linear is connected. A failed connected Linear call
stays a failure and never writes locally. GitHub connection failures still name
the recorded convention with `backend_unavailable`; report them to your lead.
Do not create another queue to compensate for an uncertain write. Explicit
export/import identity mapping is designed in ADR 0226; migration is not yet
implemented.
