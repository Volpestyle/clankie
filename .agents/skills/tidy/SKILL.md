---
name: tidy
description: Tidy finished Clankie worker panes and list merged, clean worktrees after harvesting or when asked to tidy up. Judge work and keep reports before closing; preserve owner drafts and interactive panes.
quick-action:
  name: Tidy up
  icon: broom
  selectionArg: selection
---

# Tidy the fleet

Read the current roster, the selected panes if any, and their reports. Decide
which workers have finished useful work and whose results are kept. A settled
status is a cue to inspect, not proof of completion. Keep a worker around when
follow-up work would benefit from its live context. You can tidy after harvesting
without waiting for the owner to list panes or approve each close.

Use `close_worker_pane` for each pane you judge finished, with a short one-line
reason and its saved report path when available. The service preserves its last
output and report in `worker_pane_history`, and returns an undo ID with a short
deadline. `undo_worker_pane` reopens and resumes that session.

The service protects unsent drafts, owner-interactive or hand-started panes you
did not hire, and results not kept. Unknown draft state or provenance is a
technical failure: leave that pane alone and explain the gap. A missing Herdr
session on a reattached pane is not evidence that the worker is finished or that
its results are lost. Never bypass a refusal with raw pane-close or keystrokes.

Inspect worktrees for the repositories covered by this tidy round with the
read-only `list_tidy_worktrees({ repository: REPO_PATH, mergedInto: "origin/main" })`.
Omit `mergedInto` for its `origin/main` default, or use the deliverable's requested
remote destination. List the remaining merged-and-clean candidates with path,
branch and destination evidence; explain relevant exclusions. Main, dirty,
unmerged or live worktrees are excluded; even idle/shell panes protect their
working directories. An unavailable or changing census returns no candidates.
The tool does not establish ownership or refresh the destination ref: confirm
your ownership and current landing proof before removing a candidate. This tool
lists; it never removes.

Keep one owned linked worktree per deliverable, shared by its native slices and
reviews under distinct path ownership. After its result lands, preserve needed
reports and ignored evidence, verify destination merge and clean/inactive state,
then remove it within the authorized owned cleanup. Keep another owner's tree
with that owner. Do not remove a tree just because its pane closed or its last
turn contained only a plan. A worker that acknowledged queued work still needs
to continue the authorized action or supply an actionable blocker.

Say what you closed and why in the conversation you are working in, and offer
the returned undo IDs and deadlines. Name any panes you left because of a
refusal or uncertainty, and the remaining worktree candidates. If the owner
stops the turn, stop tidying.
