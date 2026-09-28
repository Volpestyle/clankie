---
name: c
description: >-
  Group the working tree's uncommitted changes into one or more logical commits, create
  them, then rebase onto the fetched default branch only if the branch no longer merges
  clean — whole files per commit, no per-hunk splitting, no push. Invoke manually as /c.
---

# c

Turn whatever is sitting uncommitted in the working tree into clean commits, and leave the
branch mergeable onto the current remote base. This skill never pushes — that's `/p`.

## Trigger

The user types `/c`, or asks to "commit this" / "group these into commits". That ask is
the authorization — commit without checking in again.

## Steps

1. **Survey.** `git status` and `git diff` (plus `git diff --staged` if anything is already
   staged). Read every changed and untracked file before committing any of them.
2. **Group.** One coherent change → one commit. Clearly separate concerns → one commit each,
   ordered so the log reads sensibly.
   - **Whole files only.** Stage entire files (`git add <files>`); never split one file's
     hunks across commits. A file that genuinely mixes concerns stays in a single commit.
   - **Never `git add -A`.** Stage files by name. A worktree can hold an untracked
     `node_modules` *symlink* that the repo's `node_modules/` ignore pattern misses — that
     pattern only matches directories.
   - Default to fewer commits. Split only when it helps someone reading the history later.
3. **Write the message.** Match the repo's existing style (`git log --oneline -10` if unsure).
   Imperative subject, body only when the change needs explaining. Follow whatever
   commit-message rules the session already imposes.
   - Make gate-to-commit shell sequences fail fast with `&&`; newline-separated zsh
     commands keep running after a failed check and can commit what the gate rejected.
4. **Rebase — but only if the branch actually needs it.** Fetch first; the base that matters
   is what's on the remote, not a stale local `main`. Resolve the default branch from
   `git symbolic-ref --short refs/remotes/origin/HEAD` rather than assuming `main`.
   ```bash
   git fetch origin
   git merge-tree --write-tree origin/<default> HEAD >/dev/null 2>&1 || echo CONFLICT
   ```
   - Merges clean → **do not rebase.** A needless rebase rewrites every SHA and turns the
     next `/p` into a force-push for nothing. Say you skipped it.
   - `CONFLICT` → `git rebase origin/<default>` and resolve (below).
   - Already on the default branch → skip.
   - Stacked on another feature branch (`git log --oneline origin/<default>..HEAD` shows a
     parent's commits)? Check and rebase against the **parent**, not the default branch —
     otherwise the parent's commits get flattened into this branch.
5. **Report.** List the commits created, whether the rebase ran, and that nothing was pushed.

## Conflicts

**Resolve them yourself.** You just wrote this change — you know what it was for and which
lines carry its intent. Aborting hands the merge to someone with strictly less context.
Resolve by intent, never by picking a side wholesale.

- `git status` names the conflicting files; `git log --oneline origin/<default>..HEAD` and
  `git log --oneline HEAD..origin/<default>` show what each side was doing.
- **`modify/delete` is the one to slow down on.** The file was moved or folded into
  something else on the default branch. Keeping your copy resurrects a dead module nothing
  imports. `git log --diff-filter=D --oneline -- <path>` names the commit that removed it —
  find where the code lives now and reapply your change there.
- Continue with `git rebase --continue` per commit until the rebase finishes.
- **Verify after.** A resolution can break the build in ways the diff hides. Run the repo's
  typecheck/lint and any test covering what you touched.
- **Abort only on genuine ambiguity of intent** — the default branch changed the same
  behavior for a reason you can't determine from the code. Then `git rebase --abort` (the
  commits survive untouched), say what you found and what the options are. Never guess.

## Guardrails

- **Look before you wrap.** Debug prints, secrets, stray large files, half-finished edits —
  flag them and ask rather than sweeping them in.
- **Never amend or force.** Create new commits; `--amend` only on explicit request.
- **Fetch, never push.** `git fetch` is the only remote call. Never push, never write a
  remote ref — that's `/p`. If a rebase did run on an already-pushed branch, say so: the
  next `/p` has to force-with-lease.
- **Nothing to commit?** Say so and stop. No empty commits.
