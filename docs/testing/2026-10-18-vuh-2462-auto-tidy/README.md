# VUH-2462 — automatic tidy preserves unfinished work

Tracks: https://linear.app/vuhlp/issue/VUH-2462

Automatic retirement now requires positive work proof against the actual
advertised origin/main or a recorded handoff. Missing/non-Git context holds;
feature branches, local refs and patch equivalence alone do not count. Keep and
release reset the automatic idle period, including holds arriving during close.
Manual close keeps its existing explicit handoff and native guards.

Pruning preserves the exact detached HEAD of content-equivalent work under
refs/clankie/pruned-worktrees/, retains decided-drop refs, and holds native
HEAD/branch locks through removal. A live parent directory protects nested
worktrees. No force removal is used.

## Verification

The pre-fix regression runs fail on seven automatic-retirement cases and two
pruning cases. The final focused run passes 78 cases in three integration files:
automatic/main/handoff/context/keep regressions, native close guards, owner
roster retire/Undo, and guarded worktree pruning. A detached original commit
remains readable after its worktree is removed, all fixture reflogs expire and
Git garbage collection runs. A real native Git experiment confirms the HEAD
lock and prepared branch transaction refuse a racing commit while allowing
unforced worktree removal. Explicit-file formatting and lint pass.

Raw red/green reports, test output, source patch and native Git experiment are
retained in regression-proof.json through evidence.json. Earlier intermediate
implementation failures are local diagnostics, not accepted evidence.

The required exact-tree landing gate is pending; its checked SHA and result
will be reported before any core push.

## Boundaries

Every write and retirement/prune effect in these proofs uses disposable test
repositories and private native fixtures. No incident source or excluded LOCAL13
content was inspected or modified. No real panes were closed and no live
worktrees were pruned. Windows native pruning remains unproven; its existing
remote transport is unchanged. This fix conservatively holds unknown research
context; it does not claim exhaustive ownership discovery for separate trees.

Fleet status confirms autoTidy is off. The fix does not enable it. James decides
whether to enable automatic tidy again after deployment.
