# VUH-2926: a pane at $HOME no longer hides every worktree from tidy

Tracks: https://linear.app/vuhlp/issue/VUH-2926

`list_tidy_worktrees` protected every worktree nested below any live pane cwd
(the ADR 0280 rule). With the operator seat and three other panes at `$HOME`,
and two at `~/dev`, no worktree under `~/dev` could ever be a candidate.

## Rule

A pane or process cwd still protects the worktree that holds it, and the
worktrees nested below it. The exception is a cwd at `$HOME`, an ancestor of
`$HOME`, or a strict ancestor of the repository's main worktree: those hold the
whole repository, not one piece of work. The VUH-2462 research parent (a
non-Git directory holding a worker's source trees) and the main checkout (a
harness that entered a worktree inside it) keep their protection. The proposed
"non-Git cwds protect nothing nested" rule would have dropped the research
parent, so the
[ADR 0280 amendment](../../adr/0280-automatic-tidy-requires-positive-work-proof.md)
records the container rule instead.

Listing and prune now also read the native process cwd census. A process working
in a tree holds it as `live_process`, and an unknown census lists nothing. A
process that starts working in a candidate during the listing holds only that
tree. On Linux the census skips processes whose cwd the kernel withholds (other
accounts' and our own non-dumpable ones); see the amendment for the residual
risk.

Cache reclaim's 32-tree window resumes after the last tree the previous sweep
examined. The cursor lives in the repository's common Git directory and only
orders the work.

## Verification

`tidy-worktrees-home-pane.integration.test.ts` runs real Git repositories in a
scratch HOME, real shell panes in an isolated Herdr server and a real child
process.

- Panes sit at `$HOME`, `~/dev`, a research parent, inside one worktree, and at
  the main checkout. A process sits in another worktree. Only the landed tree
  is a candidate. The pane-held, process-held, research-held and
  checkout-nested trees are excluded as `live_pane` or `live_process`. After
  the process exits, its tree becomes a candidate. `prune_tidy_worktree`
  removes the landed tree while the `$HOME` panes stay open, and refuses the
  pane-held tree.
- With 34 cached worktrees, the first reclaim sweep reclaims 32 and defers 2.
  The second sweep reclaims those 2 and defers the next 2 in wrap order.

Two more cases came from Corvin's review. In the first, with the main checkout
outside `$HOME`, a `$HOME` pane still protects nothing; this pins the `$HOME`
exclusion on its own. In the second, a process that starts in a candidate
between the first census and the final re-read leaves only that tree held as
`live_process`. Removing the `$HOME` check, or the re-read, fails the matching
case.

### Linux

Proved on WSL2 Ubuntu (kernel 5.15.167.4-microsoft-standard-WSL2) as non-root
uid 1000. The runs used esbuild bundles of the real
`process-working-directories.ts` and `tidy-worktrees.ts`, with a scratch Git
repository and an empty pane runner.

- `linux-census-wsl-round1.txt`, "origin-main": pid 1 (root) returns EACCES and
  the listing is `process_inventory_unavailable`. The "fixed" run there is an
  intermediate rule that skipped only other uids. It still failed, on our own
  non-dumpable `systemd --user`, so it was replaced.
- `linux-census-wsl-option-a.txt`: the census succeeds while root pid 1 and our
  own hidden `systemd --user` and `(sd-pam)` are present, and the listing is
  `listed`. A dumpable process of ours in a tree holds it as `live_process`. A
  non-dumpable one is skipped, which is the residual risk recorded in the ADR.

The original home-pane and reclaim tests fail against origin/main `b6f701814`
sources (`red-origin-main.json`): the listing has no candidates, and the second
sweep reclaims nothing while it re-defers the same two trees. With the fix, the
new file, the five affected suites and the process census suite pass 103 of 103
(`green.json`), including the
VUH-2462 research-parent case. `apps/clankie` typecheck passes.

## Boundaries

All Git, Herdr, process, prune and reclaim effects in these proofs use scratch
directories and a private Herdr socket. No real worktree was pruned or
reclaimed. The only live reads were read-only (`herdr agent list`,
`herdr pane list`, `git worktree list`, `lsof` cwd counts), used to size the
problem. The Linux runs used a scratch directory on supedupsilly's WSL, removed
afterwards. No process stayed running. Deployment and the live acceptance check
(a real `list_tidy_worktrees` on clankie and clankie-app, then one prune) are the
lead's job. A cwd at an
enrolled worktree root such as `~/dev/clankie-wt` still holds every tree below
it, by design (see the amendment).
