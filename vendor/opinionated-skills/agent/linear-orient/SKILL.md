---
name: linear-orient
description: Orient to a Linear project or issue before working or reporting its state. Read current deliverables, active work, dependencies and decision threads first; expand into history for contradictions or an explicit full audit. Read-only; use linear-issues for writes.
---

# Linear Orientation

Build a sourced picture of what is shipping, what is in flight, and what blocks
the next result. Start with current work; a full historical audit is opt-in.
Resolve the workspace and team from the project or issue prefix.

Start from current scope, acceptance criteria and the latest result, then read
the relevant decisions and replies, including inline comments (`quotedText`).
Bodies and summaries can be stale; resolve conflicts with fresh human direction
and source evidence rather than treating a status or recap as proof.

Once context is established, retain the read boundary in the existing brief or
conversation and refresh changed issues, comments and decisions on the next wake.
Do not repeat a full thread audit for unchanged inputs. If the API cannot filter
a comment delta, paginate as needed but keep already-read payloads out of model
context. Missing context or edits to earlier decisions require re-reading that
scope; incremental reads must not silently drop human changes.

## Project orientation

1. **Current goal** — `get_project` with `includeMilestones: true`,
   `includeResources: true`, `includeMembers: true`; read its description,
   active milestone and latest project status update. Read recent project
   comments for changed priorities. Note the project UUID.
2. **Work inventory** — list active issues and recently completed deliverables,
   requesting compact fields such as title, state, owner and update time.
   Paginate the selected scope; do not silently use one page as the whole project.
3. **Relevant threads** — for the next deliverable, active/blocked lanes and
   issues carrying architecture or scope decisions, `get_issue` with
   `includeRelations: true` and establish their decision/evidence context on the
   first pass; subsequent passes refresh changes. Follow parents and
   dependencies when they change the current plan. Read recently completed
   evidence for claims about what is usable now.
4. **Canonical docs** — inspect the attached/listed documents governing that
   work. Read their comments, and milestone/status-update comments, where they
   carry decisions or contradict the current body. Inspect referenced images
   when they carry acceptance criteria text cannot establish.
5. **Expand only for a named gap** — follow cited older decisions, archived
   issues or additional lanes to resolve a contradiction, missing owner or
   acceptance criterion. Stop when the requested scope is supported; unrelated
   history does not improve a current-state answer.

## Single issue

Read the issue with relations and establish its decision/evidence context, then
its parent and relevant sub-issues/blockers with their decision threads. Refresh
changes on subsequent reads rather than replaying known history. If it belongs to a project,
read the project description and latest status update. Expand beyond that when
the issue depends on a wider decision.

## Full audit (when requested)

Enumerate every issue with `includeArchived: true`, fetch each issue and all
comments, and read all project documents, milestones, status updates and their
threads. Paginate every collection. An explicit exhaustive request requires this
depth; do not silently substitute the current-work pass. Report any unread or
unavailable scope rather than claiming completeness.

## Mechanics

- `list_issues` and `list_comments` cap at 250 per page (default 50). Follow
  pagination until the selected collection is exhausted.
- `milestoneId` and `statusUpdateId` require UUIDs: resolve with
  `list_milestones` / `get_status_updates`. Projects and issues accept names or
  identifiers; documents accept IDs or slugs.
- Batch independent reads in parallel. Keep full responses outside the main
  context when possible and return relevant excerpts; inspect every result and
  follow truncated descriptions with `get_issue`/`get_document`. Do not dump a
  whole project's payload into one tool result.
- Prefer freshly fetched state over memory. Preserve later human edits; a
  contradiction is something to resolve, not permission to restore old text.
- This skill is read-only. Route authorized follow-up writes through
  `linear-issues`; orientation alone does not authorize posting.

## Output

Synthesize the goal, usable deliverables, current owners, accepted decisions,
and next blockers with issue/comment links. Distinguish a verified candidate
from integrated or delivered work. Name unresolved contradictions and the scope
you actually read; reserve whole-project counts and exhaustive claims for a
complete enumeration of that scope.
