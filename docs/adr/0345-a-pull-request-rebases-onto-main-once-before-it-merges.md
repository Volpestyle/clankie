# ADR 0345: A pull request rebases onto main once, before it merges

Status: Accepted, 2026-11-02, on James's approval of the rule Grok proposed on
the connected-apps notes board, which he confirmed to Claude Duet ("he left u a
note"). Amends [ADR 0332](0332-clankies-own-pull-requests-merge-on-green-checks.md);
its merge on green checks stays as is.

## Context

Clankie's own repositories (clankie, clankie-app and clankie-ops) are built by
many workers at once, each in its own worktree, each ending at a pull request.
The repo guide told every pull request to keep its branch current with `main`.
Workers did that by merging `main` into their branch again and again, so each
merge on `main` set off another round of merge commits, check runs and
conflicts across every open pull request. Several pull requests touching the
same files at the same time (the voice, media and Minecraft extension work on
2026-11-01) made the churn worse.

The retired `clankie integrate` queue ([ADR 0240](0240-changes-land-directly-on-main.md))
and GitHub's merge queue would both serialize merges, at the cost of a
standing queue to run and wait on.

## Decision

These are the Clankie project's own settings for its three repositories, beside
ADR 0332. They are not a product rule.

- **Rebase once, right before merging.** A worker leaves its branch on the base
  it started from while it works. When the pull request is green and ready to
  merge, it rebases the branch onto a freshly fetched `origin/main` once, and
  pushes with `git push --force-with-lease` to its own branch only. It does not
  merge `main` into the branch.
- **Stop on someone else's conflict.** If the rebase conflicts in files the
  worker did not touch, it aborts the rebase and flags the conflict to its
  lead, rather than resolving another worker's code. Conflicts in its own files
  it resolves itself.
- **Leads keep workers off the same files.** When dispatching, a lead does not
  put two workers on the same files at once; it sequences them or gives the
  shared file one owner.
- **No queue.** Pull requests do not go through `clankie integrate` or GitHub's
  merge queue. Workers keep their own worktrees, and a ready pull request still
  merges on green checks with a plain merge (ADR 0332).

## Consequences

- One merge on `main` no longer sets every open pull request rebuilding.
- The checks that gate a merge run on the rebased head, so they reflect the
  patch as it lands.
- A worker that hits a conflict outside its own files waits on its lead, who
  decides who owns the fix.
- The repo guide, the lead guide, its connected-leads page and the worker skill
  carry the rule. "Keep its branch current with main" is a retired claim.
