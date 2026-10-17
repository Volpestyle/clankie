# VUH-2392: automatic tidy and the one-time worktree reclaim

Tracks: https://linear.app/vuhlp/issue/VUH-2392

## One-time reclaim of the backlog

A read-only census (`worktree_census.py census`) classified every registered
worktree of `~/dev/clankie` (core) and `~/dev/clankie-app` (app) and wrote the
full candidate and exclusion lists, with reasons, to `census-before.json`
before anything was removed. A candidate needed all of:

- HEAD an ancestor of freshly fetched `origin/main`;
- `git status --porcelain --untracked-files=all` empty (ignored dependency and
  build output allowed);
- no ignored files that may be evidence or source: `docs/testing/`,
  `artifacts/`, `.tmp/`, `.claude/`, `evals/`, whole ignored workspace packages,
  or nested repositories;
- no Herdr pane cwd or foreground cwd, no process cwd and no open file inside;
- no stash whose parent is in the tree's HEAD reflog or that names its branch;
- no checkout activity (root entries, index, HEAD, reflog) for 24 hours;
- no nested registered worktree, and no retained core/app sibling in the same
  parent directory (the app reads `../clankie/packages/protocol`).

Always excluded: `~/.clankie` (the pinned runtime, `updates/*/previous` runtime
retention, integration batches), every `~/dev/clankie-wt/vuh-23*` tree,
`vuh-2379`, `vuh-1728`, `vuh-2209`, Claude Code `.claude/worktrees/*`
isolation trees, locked and prunable registrations, and the main checkouts.

`worktree_census.py remove` then ran a fresh census, rechecked panes, process
cwds, cleanliness and HEAD before each tree, moved its ignored `.local` into
`~/.clankie/captain/worktree-evidence/vuh-2392-backlog-2026-10-17/` (a rename on
the same volume, so no evidence was copied or lost), and ran
`git worktree remove` without `--force`. Each repository finished with
`git worktree prune`. No branch was deleted.

| Measure (UTC)                         | Core | App | Disk free (`df -k`)        |
| ------------------------------------- | ---- | --- | -------------------------- |
| Census start 18:33                    | 585  | 195 | 490626840 KiB (467.90 GiB) |
| Before removal 18:52                  | 585  | 196 | 486802360 KiB (464.25 GiB) |
| After pass 1 19:17 (224 removed)      | 389  | 170 | 500801968 KiB (477.60 GiB) |
| After census 19:37 (other agents ran) | 390  | 171 | 498806552 KiB (475.70 GiB) |
| After pass 2 19:41 (9 removed)        | 382  | 170 | 499806852 KiB (476.65 GiB) |

Pass 1 removed 224 trees (core 196, app 28), every one with `git worktree remove`
exit 0; 156 `.local` folders (4.0 GiB) were moved into the evidence archive.
Closed panes then freed nine more trees, so pass 2 ran the same remover on
`census-after.json` and removed them (core 8, app 1; 8 `.local` moved to
`vuh-2392-backlog-2026-10-17-pass2/`). In all, 233 trees went: core 204, app 29.
Logs: `removal-log.json`, `removal-log-pass2.json`.

Net recovery was small: about 13.4 GiB between 18:52 and 19:17. This is
inferred, not measured per tree. pnpm on APFS clones dependency files from its
store (`node_modules` files have link count 1 but share blocks), so removing a
tree frees little more than its unique build output. The figure of about 234 GB
for `~/dev/clankie-wt` overstated reclaimable space. Other agents were
installing and gating on the same disk during the run.

What stays and why is in `census-after.json` (taken before pass 2, whose nine
candidates it lists), mostly unpushed commits (core
191, app 76), dirty trees (43, 19), trees with possible evidence (14, 39) and
this wave's named trees.

## Automatic tidy

`apps/clankie/test/pane-tidy.integration.test.ts` ("automatic tidy closes a
harvested, landed hire only after its idle period") drives the production
Herdr parsing, hire-ownership journal, report store and close path through the
native boundary fixture with a real Git worktree. Nothing closes inside the hour,
while a report is unread, while the pane is kept, while its commit is not on
`origin/main`, or while an unsent draft is in the input line. After the refused
attempt's retry period it closes once and posts one notice.
`apps/clankie/test/tidy-worktrees.integration.test.ts` ("automatic tidy removes
only landed, clean, idle worktrees in enrolled roots") uses a real repository
with a bare origin. Only the merged, clean, day-idle tree in the enrolled root is
removed, with its `.local` evidence archived. Recent, unlanded, dirty and
unenrolled trees stay.

The live service has not run the new sweeps yet; that needs a runtime update
the lead or James triggers.
