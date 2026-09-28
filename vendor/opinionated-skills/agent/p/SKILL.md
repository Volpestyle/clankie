---
name: p
description: >-
  Push the current branch to the same-named branch on its remote, and nothing
  else — force-with-lease when a rebase requires it, never another branch, never
  a tag or a different remote. The push counterpart to /c. Invoke manually as /p.
---

# p

Push the checked-out branch to its own remote branch. That is the whole skill.

## Trigger

The user types `/p`, or asks to "push this" / "push it up". That ask is the
authorization — push without checking in again.

## Steps

1. **Check.** `git status -sb` — confirm the branch and whether it has an upstream.
2. **Push.**
   - Upstream exists: `git push`
   - No upstream: `git push -u origin HEAD` (creates the same-named remote branch)
   - Rejected as non-fast-forward (normal after `/c` rebases): retry once with
     `git push --force-with-lease`. Still rejected → the remote moved under you;
     stop and report, don't escalate.
3. **Report.** The branch pushed and the remote it landed on.

## Guardrails

- **Same name only.** Never `git push <remote> <local>:<other>`. `HEAD` is the only
  refspec this skill writes, so the remote branch name always matches the local one.
- **`--force-with-lease` only, never bare `--force`.** The lease is what makes force
  safe here: it refuses if the remote branch moved since your last fetch, so you can
  overwrite your own rewritten history but not someone else's push. No `+refs/`,
  no `--force`, no disabling the lease.
- **Origin only.** If the branch's upstream is a different remote, use that one; never
  add or switch remotes.
- **Never push a detached HEAD, a tag, or `--all`/`--mirror`/`--tags`.**
- **Protected branches.** On `main`/`master`/`develop`, stop and ask first.
- **Nothing to push?** Say so and stop.
- Commits are `/c`'s job. If the tree is dirty, push what's committed and say what
  was left uncommitted — don't commit here.
