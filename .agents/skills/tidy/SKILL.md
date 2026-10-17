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

The service also tidies on its own under the owner's `autoTidy` fleet setting
(default `1h`): a hire whose pane has sat idle that long, with a kept report,
every report acknowledged and its work landed, is closed through the same checks
below, and landed, clean worktrees idle for a day in enrolled roots are pruned.
Acknowledge a report only once you have its result; that is what lets the pane
go. When a worker's live context is worth keeping, or the owner asks, call
`keep_worker_pane({ pane, reason })` (CLI `clankie agents keep PANE --conversation ID`);
`keep: false` (or `clankie agents unkeep`) releases it. A keep never closes
anything and never stops your own `close_worker_pane`.

Use `close_worker_pane` for each pane you judge finished, with a short one-line
reason and its saved report path when available. The service preserves its last
output and report in `worker_pane_history`, and returns an undo ID with a short
deadline. `undo_worker_pane` reopens and resumes that session.

For an abandoned fresh hire, settlement retains any live project allocation.
The `not_ready` refusal names its allocation, pane, original intent and native
receipt. Keep an orphan report (including any startup failure), then use
`close_worker_pane` from the hiring conversation. Launched but unconfirmed
hires require a settled original receipt and matching original
process birth, shell and connection. This retirement proof does not confer
confirmed project membership. The service releases the allocation only after
complete successful inventory proves its original pane absent; settlement alone
never releases it or replays a brief.

The CLI uses the same authenticated conversation tool/API:
`clankie agents retire FLEET/PANE --conversation ID --reason "Abandoned hire; report kept" --report /absolute/report.md`.
Bare pane IDs address the local fleet. Remote draft and work reads run on that
host; missing or changed evidence refuses. An `unlandedReason` cannot override
unknown work evidence or dirty files. Never raw-close after a refusal.

Hire provenance survives service replacement and same-thread `readopt_seat`,
including remote fleets. Messaging or re-adopting a hand-started pane does not
make it a hire. A legacy record with lost provenance still fails closed; do not
infer a hire from its name, report route or re-adoption.

The service protects unsent drafts, owner-interactive or hand-started panes you
did not hire, results not kept, and unlanded work: `unlanded_work` names the
worker's dirty or unreadable worktree, or commits without a handoff. Clean
unlanded commits allow close when every commit is in a live merge-queue request,
reachable from a verified pushed remote ref, or covered by a `worth_landing` or
`safe_to_drop` decision at the current HEAD. The close receipt and lead history
keep the handoff kind, commit IDs and request/ref/decision reference. Stale
tracking refs and stale decisions do not count. `git cherry` skips merges, so
unique merge resolutions require the same handoff. Dirty files always refuse,
even with a decision or `unlandedReason`. Pass `unlandedReason` only for a
deliberate decision about clean commits; it stays in the close record and ledger.
Unknown draft state or provenance is a
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

Source runtime-update worktrees have their own automatic retention after a
passed, released canary. It keeps the current pin and immediate previous runtime
plus live, canary and recovery dependencies; it never removes worker checkouts
or operation journals. Read `clankie update status --json` for `retention` and its
retained reasons. `managed_runtime` is not permission to force-remove a tree,
release a canary/recovery hold or discard an uncertain maintenance lock.

The running service observes registered local owner refs every five seconds
and fetches once a minute, so direct pushes sync automatically. Startup catches
up pushes missed while stopped. `clankie checkouts sync` (optionally selecting
`--repository`) is the immediate/manual recovery route. It fetches main and
fast-forwards only an owner checkout on `main` with no local commits and no
edits overlapping incoming paths. Disjoint local edits survive. `blocked`
results name files and their age; preserve those files and report the blocker.
`clankie checkouts status`, doctor, and roster checkout cards use cached
`origin/main` and say so; roster/fleet checkout observations require explicit
`includeCheckouts: true`, cache owner discovery and inspection together for
30 seconds, and retain at most 128 cwd observations. Default fleet reads do no
checkout Git work. Sync and hire admission require a successful fetch.
New hires fetch `origin/main` on that machine. A clean behind-only start,
including detached HEAD, fast-forwards after checking its live pane census.
Dirty and divergent starts refuse. Live and managed-runtime checkouts never auto-advance. Ignored files
are never overwritten, stashed or deleted. Fresh topic branches are accepted.
A dirty-start refusal names up to 20 blocking paths, including
untracked directories. Preserve those files; create a fresh owned deliverable
worktree from fetched `origin/main`. Resuming a saved session keeps its exact directory.

For disk pressure, use `reclaim_tidy_worktree_caches({ repository, path? })`
(or `clankie checkouts reclaim-caches --repository OWNER_CHECKOUT [--path WORKTREE]`).
It removes only ignored package-manager installs and tagged Rust build caches
in enrolled linked worktrees clean and idle for six hours, with a complete native
process cwd and pane census. Commits, edits, logs and `.local` evidence stay.
Unknown, recent, dirty, live or managed trees stay. Report the returned paths and
refusals. Cache deletion is manual; reinstall or rebuild before resuming that tree.

Large-install receipts distinguish bounded ignored-Git output (`git_output_limit`,
phase and byte limit) from nested-repository checks (`cache_inventory_depth_limit`,
`cache_inventory_time_limit`, cache/phase/directory and observed counts). Complete
streaming checks run before and after renaming, with depth 40, at most 41 directory
handles and a 60-second budget checked between entries; filesystem I/O can take longer.
An incomplete check keeps the cache intact. Workspace importer caches use their own
install metadata or the root pnpm marker plus installed lockfile snapshot naming the
canonical project; changing or unknown evidence is refused. Root caches go last.
Each sweep examines at most 32 worktrees and every cache within them. Report all
`cache_worktree_limit` deferred paths and continue with each exact `path`.
