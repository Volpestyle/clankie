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
pruning cases. The final focused run passes 79 cases in three integration files:
automatic/main/handoff/context/keep regressions, native close guards, owner
roster retire/Undo, and guarded worktree pruning. A detached original commit
remains readable after its worktree is removed, all fixture reflogs expire and
Git garbage collection runs. A real native Git experiment confirms the HEAD
lock and prepared branch transaction refuse a racing commit while allowing
unforced worktree removal. Explicit-file formatting and lint pass.

Raw red/green reports, test output, source patch and native Git experiment are
retained in regression-proof.json and regression-proof-v2.json through
evidence.json. The second proof adds a direct detached/unpushed start directory
and corrects cleanup error handling found by the first landing gate. Earlier intermediate
implementation failures are local diagnostics, not accepted evidence.

The exact-tree root `check:landing --retry-failed-tests` passed on
`39102f25b8b575d2b14915254758f2b12490b758` over `81414ad53`, with stable source
and all five affected package typechecks passing. The selected suite first
reported 651 pass, one failure and eight skips. The unchanged runtime-terminals
case passed its one supported isolated rerun: 652 cases passed in all. No timing
or assertion was weakened and no manual exception was used. The 79 focused
retirement/roster/pruning cases also pass within the selected gate. Full gate,
compiler and retry artifacts are retained in landing-gate.json. This checked
source was pushed to main; deployment remains the lead's responsibility.

## Boundaries

Every write and retirement/prune effect in these proofs uses disposable test
repositories and private native fixtures. No incident source or excluded LOCAL13
content was inspected or modified. No real panes were closed and no live
worktrees were pruned. Windows native pruning remains unproven; its existing
remote transport is unchanged. This fix conservatively holds unknown research
context; it does not claim exhaustive ownership discovery for separate trees.

Fleet status confirms autoTidy is off. The fix does not enable it. James decides
whether to enable automatic tidy again after deployment.
