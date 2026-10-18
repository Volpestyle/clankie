# ADR 0280: Automatic tidy requires positive work proof

Status: Accepted, 2026-10-18. Tracks [VUH-2462](https://linear.app/vuhlp/issue/VUH-2462).

Automatic tidy closed held research seats and removed a checkout before its
work had landed. Missing Git context had been treated as no outstanding work,
and a pushed feature branch was accepted as a landing. Content-equivalent
detached commits could lose their only reference when a worktree was pruned.

Automatic pane retirement now requires positive work evidence for both the
start and foreground directory. Missing directories, non-Git parents and absent
observations hold the pane. This deliberately preserves an unattributed research
context rather than claiming to discover every separately owned source tree.
No source directory is recursively searched to infer ownership.

For automatic retirement, landing means ancestry in the actual advertised
`origin/main`, or an existing explicit handoff covering every unlanded commit:
a retained merge-queue request or a current-HEAD `worth_landing`/`safe_to_drop`
decision. Local tracking refs, patch equivalence, arbitrary remote branches and
tags cannot establish automatic landing. Failed or changing Git observations
hold the pane. Manual `close_worker_pane` keeps its explicit, recorded handoff
behavior and never bypasses dirty-file, draft, provenance or native-close guards.

A kept pane accrues no automatic idle time. Keep and release change a volatile
generation alongside the volatile idle clock, so a release between sweeps still
starts a full new period. Automatic close rechecks the keep and generation at
the native dispatch boundary. A manual close remains an explicit lead decision.
Closure does not declare the issue Done; existing issue settlement still applies.

A live pane protects worktrees containing its cwd and worktrees nested below
that cwd. Pruning retains the exact original HEAD for content-equivalent commits
under `refs/clankie/pruned-worktrees/`; decided drops retain the existing
`refs/clankie/dropped-worktrees/` reference. These references survive reflog expiry
and garbage collection. An exclusive native HEAD lock and, for a symbolic HEAD,
a prepared read-only branch-ref transaction prevent a concurrent commit or
checkout from losing its only reference during removal. Changed or busy refs
refuse removal. Git removal remains unforced and all existing cleanliness,
process, pane, runtime and evidence guards remain.

Automatic tidy remains off in the affected fleet. Landing this fix does not
enable it; James decides whether to enable it again. Regression proofs use
disposable Git repositories and native-close fixtures, never incident worktrees.
