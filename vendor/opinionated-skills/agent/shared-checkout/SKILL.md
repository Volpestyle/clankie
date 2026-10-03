---
name: shared-checkout
description: Git discipline for committing in a checkout that other agents are working in at the same time. Use before staging, committing, amending, resetting, or rebasing anywhere sibling agents may share the working tree or index — a herdr lane, a wave of workers in one repo, any brief that says "commit your work" without giving you your own worktree. Also use when a commit you made has vanished, when a commit picked up files you never touched, or when deciding whether work needs its own worktree. Not for ordinary solo-repo git.
---

# shared-checkout

One git index per checkout, several agents writing to it. The index and the
branch are shared mutable state with no locking, so the usual solo-repo moves
are unsafe here: they silently destroy work that was correct when it was
written.

Everything below is derived from real losses in one clankie-app wave — a
`reset` that dropped two lanes' commits, and an `amend` that swept up a third
lane's staged files.

## Am I in a shared checkout?

Assume yes whenever a brief put you in a repo you did not create a worktree
for. To confirm, ask herdr who else is there:

```bash
herdr agent list
```

Two agents in different *subdirectories* of one repo still share one index.
Separate worktrees do not — they have their own index and HEAD, which is why
a brief that hands you your own worktree is handing you the whole problem
already solved.

## Never rewrite shared history

`git reset` (any mode), `git commit --amend`, `git rebase`, and
`git checkout -- <path>` on a shared branch all discard state a sibling may
have created seconds ago. You cannot check first: the window between your
read and your write is exactly where the other agent commits.

**`git stash` belongs on that list, and it is the one you will reach for.**
It reads as saving rather than rewriting, which is exactly why it slips past
the instinct that stops the others. Bare `git stash push` takes *every*
modified tracked file — every sibling's in-flight edit — and reverts the
working tree out from under agents that are still running in it. To park your
own copy of a file for a red/green comparison, use `cp`.

The stash stack is also **repository-global, not worktree-local**: `refs/stash`
is shared by every worktree of one repo, so your own worktree is not the
shelter it looks like. A `stash push` there lands on the same stack a sibling
in another worktree pops from, and `git stash list` shows you their entries
next to yours. Use `cp` for your own copy; if you must stash, pop by name
(`git stash pop stash@{n}` after checking `git stash list`) rather than
trusting the top of the stack.

Add a new commit instead. A slightly untidy history is recoverable; a
`reset` is what someone reconstructs from reflog at 3am.

If you genuinely must fix your own last commit, make a second commit that
fixes it. Squashing is the integrator's job, once the lane is quiet.

## Photograph the tree before you touch it

Capture the state before staging anything:

```bash
git status --porcelain > /tmp/before.txt
```

Verifying what you staged is only half the job; the other half is being able to
prove what you *did not* disturb, which you cannot reconstruct afterwards from
memory. Diff against it before you report.

## Stage by path, never by wildcard

`git add -A`, `git add -u`, and `git add .` stage whatever the other agents
have edited too, and you will commit it under your name and your message.

```bash
git add apps/mobile/thing.ts apps/mobile/thing.test.ts
```

Name every path. If that list is long enough to be annoying, that is the
signal your lane is too wide, not a reason to reach for a wildcard.

## Re-check the index in the same breath as the commit

The index can change between your `git add` and your `git commit` — a sibling
staging its own work lands in *your* next commit. So verify immediately
before committing, not at the top of the task:

```bash
git diff --cached --name-only    # must list only your files
git commit -m "..."
git show --stat HEAD             # confirm what actually landed
```

The `--stat` check afterwards is the one people skip and the one that catches
the sweep. Do it every time.

## A file that holds your hunks and someone else's

Do not commit the mixture and do not drop your fix. Stage only your hunks:

```bash
git diff -- <file> > /tmp/mine.patch
# keep only the hunks containing your identifiers, then:
git apply --cached /tmp/mine.patch
```

Afterwards confirm the other agent's hunks survive unstaged (`git diff -- <file>`
still shows them). Name the orphan work in your report rather than silently
leaving or absorbing it.

## Landing a reviewed branch into a dirty shared checkout

A lead landing a worker's branch while another agent has uncommitted work in
the checkout uses the bundled script rather than hand-applying patches:

```bash
node <this skill>/scripts/land.mjs <branch> --dry-run   # what it would do
node <this skill>/scripts/land.mjs <branch>
```

The branch must contain HEAD (have its owner rebase it first). HEAD moves to
the branch exactly, keeping its commits and tested tree. Each changed path in
the working tree becomes the branch's version, or a clean three-way merge where
someone has uncommitted edits. It refuses, changing nothing, on a conflict, a
staged index, an untracked file in the way, or a new ADR whose number
uncommitted work already uses.

## When your commit has disappeared

It is almost certainly still in the reflog, unreachable rather than gone:

```bash
git reflog --date=iso | head -40
git show <sha>                       # confirm it is yours
git cherry-pick <sha>                # or re-stage the paths and re-commit
```

Recover only your own commit. Re-committing a sibling's work under your
authorship makes the tangle worse — tell the lead the sha instead.

## Report what you did to shared state

Any commit, any push, and above all any history rewrite you performed or
recovered from belongs in your final report with its sha. The lead is
reconciling several lanes against one branch and cannot see your reasoning,
only the result.
