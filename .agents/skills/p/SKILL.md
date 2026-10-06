---
name: p
description: >-
  Push the current branch to the same-named branch on its remote, and nothing
  else — force-with-lease only for your authorized rewritten branch, never
  another branch or tag. Invoke manually as /p.
---

# p

A request to push authorizes this branch's push. Verify the authenticated account
and repository destination first; a worker uses the task's authorized account.
A request to commit alone does not authorize a push.

Read `git status -sb`, the current branch, remote URL and upstream. Select the
branch's configured remote, or `origin` when it has none. Push an explicit
same-name refspec: `git push REMOTE HEAD:refs/heads/BRANCH`. Never trust plain
`git push` to select the destination: a worktree created from `origin/main` can
inherit that upstream while its local branch has a different name. Set upstream
with `-u` only to the same-named branch. Stop on detached HEAD.

If rejected as non-fast-forward, inspect the remote branch. Use
`--force-with-lease` only when your authorized rebase rewrote your own commits
and the lease covers the remote revision you inspected. A remote advance or
shared branch needs coordination, not an automatic forced retry. Load
`shared-checkout` before changing shared state. Never use bare `--force`, push
another branch or tag, delete a ref, or change remotes to make a push succeed.

Report the branch, remote and resulting commit. A failed check, credential prompt
or rejection remains a failure; do not report it as published.
