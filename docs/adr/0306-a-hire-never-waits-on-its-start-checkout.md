# ADR 0306: A hire never waits on its start checkout

Status: Accepted, 2026-10-31, on James's word that a dirty start checkout
"shouldn't block us rn", "as long as we have a way to recover still".

## Context

A new hire runs in the folder it was started from. Before launch, Clankie
fetches `origin/main` on that machine, fast-forwards a clean behind-only
checkout, and refused every other start: uncommitted changes, local commits
that `origin/main` does not have, a checkout a live pane owns, a fast-forward
that Git would not make. The refusal told the caller to make a clean worktree
from `origin/main` by hand. In practice the owner's working copy on a PC is
often mid-change, so hires into it simply failed ("Start checkout is dirty").

## Decision

When the start checkout can't be used as it is, the hire gets its own worktree
instead of a refusal.

- **The start checkout is left exactly as it was.** Its files, index, HEAD,
  branch and stash are untouched; that is the way back to the owner's work.
  The only write near it is `/.local/` in the repository's own
  `.git/info/exclude` when nothing ignores `.local` yet, so its status does not
  change.
- **The worktree is fresh `origin/main` on a new branch.**
  `<start>/.local/wt-<name>-<hex>`, branch `clankie/<name>-<hex>`, both named
  from the hire's title, made with hooks off from the fetched `origin/main`.
  A hire started in a subfolder starts in that subfolder's twin when it exists
  on `origin/main`, otherwise at the worktree's root. The worker's brief names
  the start checkout, why it was left alone, the worktree and the branch.
- **It applies to:** uncommitted changes, diverged local commits, a live pane
  in the checkout, an unavailable live-pane census, and a fast-forward that
  failed. A clean checkout already containing `origin/main`, or behind it with
  nothing in the way, is still used directly.
- **Still refused:** no fresh `origin/main` (fetch or verification failed), and
  a managed runtime (`~/.clankie/pinned`, `runtimes`, `updates`, or the
  service's own runtime), whose folders an update replaces along with anything
  inside them.
- **Same on every machine.** The local check (`verifyHireCheckout`) and the
  program the service runs on a linked PC behave the same. A PC's exact
  directory grant also covers the hire's worktree inside it
  (`<granted>/.local/wt-*`, or the twin of a granted subfolder), since that is
  the granted checkout's own work.
- **The worktree keeps its start's project.** Project resolution, local and on
  a PC, falls back from the worktree directory to its start checkout, so a
  project registered at a subfolder still owns that subfolder's twin. A hire
  started inside another hire's worktree gets its own nested one, and grants
  and projects walk out through each start.
- **A retry returns to its first worktree.** The service records each start
  folder's last relocation (`hire-worktrees.json` in its state directory).
  While the launch into that worktree is unresolved (an unconfirmed allocation
  or an open hire receipt) or was settled by recovery, a hire from the same
  start folder on the same machine reuses that worktree and brief line instead
  of making another, so the allocation and receipt checks of
  [ADR 0207](0207-work-records-and-native-agent-delivery.md) see the first
  attempt and no second agent starts. Only one hire from a start folder is
  admitted at a time. Once the launch resolves, the next hire gets a new
  worktree.

A worktree left by a hire that failed later is clean at `origin/main`, so the
usual tidy removes it once no pane or process is in it. Calling
`verifyHireCheckout` without the worktree option keeps the old refusals.

## Consequences

- Hires no longer fail because the owner is in the middle of something.
- A worker never sees the owner's uncommitted changes or local commits; work
  that should build on them still needs them committed and pushed first, or a
  hire started in a checkout that holds them cleanly.
- A start checkout that is itself a linked worktree now holds the hire's
  worktree, so tidy keeps it while that nested worktree exists, as tidy already
  does for any worktree registered under `.local`.
