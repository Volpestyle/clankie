# VUH-2932: pruning a worktree frees disk instead of costing it

Tracks: https://linear.app/vuhlp/issue/VUH-2932

Prune kept a tree's `.local` by copying it into `worktree-evidence/`. pnpm
installs on APFS are clones of its store, so the copy wrote out every block
while removing the tree freed almost none. Pruning 39 trees cost about 11 GB.

## Change

- `.local` is renamed into the evidence store under the tree's HEAD and branch
  locks, after the fresh census: no new disk on the same volume. Another volume
  falls back to copying all but the regenerable content.
- Regenerable content is not kept: `node_modules`, `.turbo`, `DerivedData`,
  `.pnpm-store`, `.gradle`, `.next`, and Rust `target` with a `CACHEDIR.TAG`.
  Each one moves to the store's `.trash` and is deleted off the request path; the
  result lists them as `discarded`. Nested clones keep their `.git`.
- A worktree registered inside `.local` refuses the prune
  (`nested_worktree: .local/...`), so it is pruned on its own and never moved.
- A failed `git worktree remove` reports `left` (still registered, directory
  present, `.local` `restored` or `kept`). `.local` returns only to a tree Git
  still holds intact.
- Batch prune (`paths`, or repeat `--path`, up to 64) does one fetch and one
  admission listing, deepest trees first, and freshly checks each tree before
  removal. The CLI waits up to 30 minutes for the answer instead of aborting
  at two.
- Decision recorded as an
  [ADR 0280 amendment](../../adr/0280-automatic-tidy-requires-positive-work-proof.md).

## Verification

`apps/clankie/test/prune-evidence-disk.integration.test.ts` uses real Git
repositories, real files and `statfs`.

- Heavy `.local`: a nested clone with a pnpm-style install, `.turbo`, a tagged
  Rust `target`, real evidence and an untagged `target`. Free disk rises by about
  the regenerable 256 MiB (`df-runs.txt`: +183 MB to +266 MB against 268 MB). The
  kept recording has the same inode in the store, so it was moved, not copied.
  The evidence, the nested `.git` and the untagged directory stay; the caches go.
- `.local` holding two APFS clones of one 128 MiB file: free disk stays flat
  (−6.7 MB to +39 MB). On origin/main the copy costs −275 MB and −286 MB.
- A removal Git refuses after the fresh census (a late `worktree lock`) reports
  `left: { registered, directory, evidence: "restored" }` with `.local` back in
  place.
- A worktree of another repository registered inside `.local` refuses with
  `nested_worktree: .local/pair/other`; its registration stays intact. origin/main
  moved it and removed the tree.
- A batch of three, one nested inside another's `.local`, removes the nested
  tree first, then its parent and the sibling. It reads the pane inventory 8
  times, against 12 for three single prunes, with one fetch instead of three.

All five fail against origin/main `cfabb1853` sources (`red-origin-main.json`).
With the fix, those five and the five existing tidy suites pass 106 of 106
(`green.json`). The old copy-failure case in `tidy-worktrees` now proves that
unreadable evidence is moved intact.

## Limits

- I can't test the service's CPU alarm without bulk-pruning real trees, which
  this work must not do. The copy, which read and wrote every byte of each
  `.local`, is gone. A batch halves pane and process reads and fetches once.
  The live bulk prune is the lead's check.
- The tree's own in-tree `node_modules` are still deleted by `git worktree
remove`, which has a 60-second Git timeout. A timeout now reports what it left.
