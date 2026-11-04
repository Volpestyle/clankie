# 0357. A merged pull request settles an attempt

Status: Proposed, 2026-11-04, for #703. Records the attempt settlement that #602 shipped and its follow-up.

A deliverable claim gives one live hire per project the work on an issue (#602).
A lead can still race several harnesses or models at the same issue on purpose,
each one hired as an `attempt` in its own worktree. When an attempt's pane
closes, the host settles which attempt won and marks the live siblings
`superseded`, so the lead knows which panes to close.

## Decision

An attempt wins only through evidence the host keeps. Before the harness
launches, each hire records its branch, the commit it starts from, and the time.
GitHub then has to show a pull request merged from that branch into the default
branch after the hire, with a head that descends from the start commit. Once
every attempt has such a merge, the earliest merge wins. Without that, or if the
attempts changed while GitHub was read, nothing is set and the lead is told the
candidates. Nothing the worktree writes counts: commits, reflogs and
cherry-picked copies are all forgeable by the worker being judged.

**Remote attempts record the same launch.** A hire on a linked PC gets its own
worktree, which that machine's checkout program makes from fetched origin/main
before launch. The machine reports the new branch and its commit, and the
service checks that the commit is origin/main. The hire keeps that branch,
commit and time as its launch record. The record holds no path on the PC, so
local Git never treats it as this Mac's worktree. A remote hire that starts in
place, in a checkout already at origin/main, made no branch of its own and
records nothing; its deliverable is left to the lead, as it was before.

**A squash merge counts.** Only the merged pull request's head is compared
with the start commit. The default branch's history is never compared, so a
project that squashes, whose main holds none of the attempt's own commits,
settles like one that merges plainly. Clankie's own repository merges plainly
([ADR 0332](0332-clankies-own-pull-requests-merge-on-green-checks.md)).

**Path-scope claims are declined.** #602 left open an optional step: declare a
file or path scope with a claim, and refuse overlapping scopes across different
issues. It isn't built:

- Every hire already works in its own worktree, so two workers never share
  files on disk. Overlap appears only at merge, where Git resolves it and the
  pull request rebases once onto main
  ([ADR 0345](0345-a-pull-request-rebases-onto-main-once-before-it-merges.md)).
- A scope declared before the work starts is a guess. It would refuse
  legitimate work, or miss the files the work actually touches.
- The lead already keeps two workers off the same files. That is a leadership
  judgment the lead skill teaches, not a host gate.

Revisit this if conflicting merges between different issues become a
measured cost.

## Consequences

- A PC attempt that lands supersedes its siblings without the lead closing
  them by hand.
- A project that squashes gets the same automatic settlement.
- Settlement still needs GitHub. A deliverable that is not `owner/repo#N`, or
  an attempt whose pull request hasn't merged, leaves the decision to the
  lead.
