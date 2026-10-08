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
did not hire, results not kept, and unlanded work: `unlanded_work` names the
worker's worktree with commits not on `origin/main` by content or uncommitted
files. `git cherry` skips merge commits: a merge not reachable from main
also holds close and prune, even if all its ordinary patches landed. Land it
or inspect its resolution and record a deliberate decision. Land other work
or hand it to its owner first. Pass `unlandedReason` only when
leaving it is a deliberate decision (superseded, a spike); the reason stays
with the close record and the worktree's decision. Unknown draft state or provenance is a
technical failure: leave that pane alone and explain the gap. A missing Herdr
session on a reattached pane is not evidence that the worker is finished or that
its results are lost. Never bypass a refusal with raw pane-close or keystrokes.

Inspect worktrees for the repositories covered by this tidy round with the
read-only `list_tidy_worktrees({ repository: REPO_PATH, mergedInto: "origin/main" })`.
Omit `mergedInto` for its `origin/main` default, or use the deliverable's requested
remote destination. List the remaining landed candidates with path,
branch and destination evidence (`landedBy: content` means every commit is on
the destination by patch; `decision` means a recorded safe_to_drop); explain
relevant exclusions. Main, dirty, unlanded or live worktrees are excluded.
Classify each retained unmerged or dirty tree: landed by content, worth
landing, or safe to drop, and record the last two with
`decide_tidy_worktree` and a one-line reason. Unlanded work is never removed
without one, and a decided drop keeps its commits under
`refs/clankie/dropped-worktrees/`; uncommitted files are never pruned. Even idle/shell panes protect their
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

For an authorized owned cleanup, use `prune_tidy_worktree({repository, path})`
(or `clankie checkouts prune --repository OWNER_CHECKOUT --path WORKTREE`). It
fetches `origin/main`, verifies a registered linked-worktree root, copies ignored
`.local` evidence to `worktree-evidence/` under Clankie’s configured state directory
(default `~/.clankie/captain/worktree-evidence/`), then freshly checks
landing, cleanliness and every live local pane's cwd and foreground cwd. It uses
`git worktree remove` without force and deletes only a merged local branch.
Managed runtime pins, runtime/update namespaces, the running service checkout and
owner main checkouts are protected independently of developer-root enrollment. Never treat a
removal refusal as permission to force it. Keep live workers' owned trees even
when their pane still reports the main checkout as its cwd. The read-only list
is a candidate inventory, not ownership proof.

After an integrator confirms a push, run `clankie checkouts sync` for registered
local owner repositories (or select one with `--repository`). It fetches main
and fast-forwards only an owner checkout on `main` with no local commits and no
edits overlapping incoming paths. Disjoint local edits survive. `blocked`
results name files and their age; preserve those files and report the blocker.
`clankie checkouts status`, doctor, and roster checkout cards use cached
`origin/main` and say so; roster/fleet checkout observations require explicit
`includeCheckouts: true`, cache owner discovery and inspection together for
30 seconds, and retain at most 128 cwd observations. Default fleet reads do no
checkout Git work. Sync and hire admission require a successful fetch.
New hires need a clean checkout containing fetched `origin/main`, on that
machine. A dirty-start refusal names up to 20 blocking paths, including
untracked directories. Preserve those files; create a fresh owned deliverable
worktree from fetched `origin/main`. Resuming a saved session keeps its exact directory.
