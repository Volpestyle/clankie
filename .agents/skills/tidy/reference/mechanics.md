# Tidy mechanics

Detail for [tidy](../SKILL.md): owner roster routes, recovering abandoned or
restored hires, runtime and checkout maintenance, and cache reclaim.

## Automatic tidy

Automatic landing counts only actual advertised `origin/main` ancestry or an
explicit retained merge-queue/current-HEAD work decision covering every unlanded
commit; a feature branch, local ref or patch equivalence alone does not count.
Kept time does not count toward automatic retirement, and automatic close
rechecks a new keep before native dispatch. Landed, clean worktrees idle for a
day in enrolled roots are pruned. The close receipt and lead history keep the
handoff kind, commit IDs and request/ref/decision reference.

A decided drop keeps its commits under `refs/clankie/dropped-worktrees/`;
content-equivalent pruning preserves the exact original HEAD under
`refs/clankie/pruned-worktrees/`.

## Owner roster routes

For the owner's at-a-glance inventory, `clankie fleet roster` reads the same
host counts as the app, including machine/lead groups, stale flags and source
warnings. An incomplete read never proves agents absent. The explicit owner
route `clankie fleet roster retire SEAT OCCUPANT` accepts only a finished or
stale exact occupant and retains every close guard; `clankie fleet roster undo
HISTORY_ID` uses the returned five-minute undo window. These routes require
owner authority; they are not another lead's permission to steer a hire. Never
retry a mutation automatically after an uncertain response.

## Abandoned and restored hires

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

A remote Herdr restore may preserve the hired session but replace its terminal
and process. Use the same `close_worker_pane` route: it can recover a completed
hire from its explicit persisted hiring owner, exact completed receipt and
unchanged host, with a complete unique-session census and fresh native process
proof rechecked until close. The session must be idle in its original pane and
directory. The close history keeps `restoredHire` evidence; original launch
records remain intact. Missing receipts, unknown hiring ownership and
unconfirmed launches still refuse. This grants no messaging, adoption or
project membership, and keeps every result, draft and work check.

## Pruning an owned worktree

For an authorized owned cleanup, use `prune_tidy_worktree({repository, path})`
(or `clankie checkouts prune --repository OWNER_CHECKOUT --path WORKTREE`). It
fetches `origin/main`, verifies a registered linked-worktree root, copies ignored
`.local` evidence to `worktree-evidence/` under Clankie’s configured state directory
(default `~/.clankie/captain/worktree-evidence/`), then freshly checks
landing, cleanliness and every live local pane's cwd and foreground cwd. It uses
`git worktree remove` without force and deletes only a merged local branch.
Native HEAD/branch locks hold the verified commit stable through removal; a
changed or busy ref keeps the checkout. Retained refs preserve detached commits
even after reflog expiry and garbage collection.
Managed runtime pins, runtime/update namespaces, the running service checkout and
owner main checkouts are protected independently of developer-root enrollment. Never treat a
removal refusal as permission to force it. Keep live workers' owned trees even
when their pane still reports the main checkout as its cwd. The read-only list
is a candidate inventory, not ownership proof.

## Runtime-update worktrees

Source runtime-update worktrees have their own automatic retention after a
passed, released canary. It keeps the current pin and immediate previous runtime
plus live, canary and recovery dependencies; it never removes worker checkouts
or operation journals. Read `clankie update status --json` for `retention` and its
retained reasons. `managed_runtime` is not permission to force-remove a tree,
release a canary/recovery hold or discard an uncertain maintenance lock.

## Owner checkout sync

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

## Reclaiming caches

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
