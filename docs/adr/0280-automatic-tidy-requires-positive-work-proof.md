# ADR 0280: Automatic tidy requires positive work proof

Status: Accepted, 2026-10-18. Tracks [VUH-2462](https://linear.app/vuhlp/issue/VUH-2462).

Automatic tidy closed held research seats and removed a checkout before its
work had landed. Missing Git context had been treated as no outstanding work,
and a pushed feature branch was accepted as a landing. Content-equivalent
detached commits could lose their only reference when a worktree was pruned.

Automatic pane retirement now requires positive work evidence for both the
start and foreground directory. Missing directories, non-Git parents and absent
observations hold the pane. This deliberately preserves an unattributed research
context rather than claiming to discover every separately owned source tree.
No source directory is recursively searched to infer ownership.

For automatic retirement, landing means ancestry in the actual advertised
`origin/main`, or an existing explicit handoff covering every unlanded commit:
a retained merge-queue request or a current-HEAD `worth_landing`/`safe_to_drop`
decision. Local tracking refs, patch equivalence, arbitrary remote branches and
tags cannot establish automatic landing. Failed or changing Git observations
hold the pane. Manual `close_worker_pane` keeps its explicit, recorded handoff
behavior and never bypasses dirty-file, draft, provenance or native-close guards.

A kept pane accrues no automatic idle time. Keep and release change a volatile
generation alongside the volatile idle clock, so a release between sweeps still
starts a full new period. Automatic close rechecks the keep and generation at
the native dispatch boundary. A manual close remains an explicit lead decision.
Closure does not declare the issue Done; existing issue settlement still applies.

A live pane protects worktrees containing its cwd and worktrees nested below
that cwd. Pruning retains the exact original HEAD for content-equivalent commits
under `refs/clankie/pruned-worktrees/`; decided drops retain the existing
`refs/clankie/dropped-worktrees/` reference. These references survive reflog expiry
and garbage collection. An exclusive native HEAD lock and, for a symbolic HEAD,
a prepared read-only branch-ref transaction prevent a concurrent commit or
checkout from losing its only reference during removal. Changed or busy refs
refuse removal. Git removal remains unforced and all existing cleanliness,
process, pane, runtime and evidence guards remain.

Automatic tidy remains off in the affected fleet. Landing this fix does not
enable it; James decides whether to enable it again. Regression proofs use
disposable Git repositories and native-close fixtures, never incident worktrees.

## Amendment: home and repository containers protect nothing below them, 2026-10-27

Tracks [VUH-2926](https://linear.app/vuhlp/issue/VUH-2926). On the live Mac,
`list_tidy_worktrees` found no candidates in clankie or clankie-app (about 670
worktrees, all `live_pane`) with 104 GiB of 3.6 TB free. Four panes, including
the operator seat, sat at `$HOME` and two at `~/dev`. The nested-below rule
above protected every worktree under them.

The proposed fix was that a cwd outside any Git worktree should never protect
the worktrees nested below it. That would also drop the case this ADR keeps on
purpose: a research seat holding its source trees in a non-Git parent
directory. So the rule names containers instead. A pane or process cwd still
protects the worktree that holds it, and still protects the worktrees nested
below it, unless that cwd is `$HOME`, an ancestor of `$HOME`, or a strict
ancestor of the repository's main worktree. Those directories hold the whole
repository and its siblings, never one piece of work. The main checkout itself
still protects worktrees inside it, for harnesses that enter a worktree under
the checkout while their pane stays at the checkout.

Listing and pruning now also read the account's native process cwd census
(the one cache reclaim already uses) under the same rule. A process working in
a tree holds it as `live_process` even when no pane is there, and an
unavailable census returns `process_inventory_unavailable` with no candidates.
The final check before returning re-reads the census. If a process has started
working in a candidate, only that tree is held, as `live_process`; a busy tree
never withholds the whole listing.

On Linux the census reads `/proc/<pid>/cwd`, and the kernel's ptrace check
(proc(5)) withholds the cwd of every other account's process and of our own
non-dumpable ones. On an ordinary systemd host those include `systemd --user`
and `(sd-pam)` for every login session, and `ssh-agent` or `gpg-agent` where
they run. Failing closed on them would leave Linux listing, pruning and cache
reclaim unavailable on every such host (shown on WSL2 Ubuntu as uid 1000;
evidence in `docs/testing/2026-10-27-vuh-2926-tidy-home-pane`). So the Linux
census skips any process whose cwd the kernel withholds (EACCES or EPERM),
whatever its uid. Every dumpable process, which covers shells, editors, builds
and agents, stays in the census. The residual risk is a non-dumpable process of
our own uid working in a worktree that no pane and no dumpable process occupies.
Even then, prune still requires a clean tree landed on `origin/main` (or a
recorded decision), removes it unforced, and keeps its HEAD under the retained
refs above. Darwin's helper reads every process of this account and is
unchanged.

A cwd at an enrolled worktree root, such as `~/dev/clankie-wt`, still protects
every tree below it, the same as a research parent. It doesn't contain the main
worktree, and nothing else separates it from a research parent without reading
enrollment. This hold fails safe: it shows as `live_pane` on every tree below
that root.

Cache reclaim's 32-tree sweep window now advances. Eligible trees are ordered
by path, and each full sweep resumes after the last tree the previous sweep
examined, wrapping round. The position is kept in the repository's common Git
directory. It only orders the work and never admits a tree; a missing or
unreadable cursor restarts at the first tree.

## Amendment: evidence is moved, and regenerable content is not kept, 2026-10-28

Tracks [VUH-2932](https://linear.app/vuhlp/issue/VUH-2932). Prune kept a tree's
`.local` by copying it into the evidence store. On APFS, pnpm installs are clones
of its store, so the copy wrote out every block while deleting the original
freed almost none. Pruning 39 trees grew the store to 24 GB, 20.3 GB of it
`node_modules` in nested `.local` checkouts, and lowered free disk by about
11 GB.

Prune now renames `.local` into the store while it holds the tree's HEAD and
branch locks, after the fresh census. On the same volume that costs no new disk.
Across volumes it copies all but the regenerable content. Regenerable installs
and caches (`node_modules`, `.turbo`, `DerivedData`, `.pnpm-store`, `.gradle`,
`.next`, and Rust `target` with a `CACHEDIR.TAG`) are discarded rather than kept.
They move into the store's `.trash` and are deleted off the request path; a
sweep a restart interrupts finishes on the next prune. Nested clones keep their
`.git`. A worktree registered inside `.local` refuses the prune, so it is pruned
on its own and its registration never breaks. If Git's removal fails, `.local`
goes back only into a tree Git still holds intact (registered, present and
clean). Otherwise it stays in the store, and the result says what was left.

A batch prune fetches once and admits every tree from one listing. Each tree
still gets its own fresh pane and process census right before removal, because
admission alone cannot see a worker that arrived since.
