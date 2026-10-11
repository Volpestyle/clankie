# Isolation child progress (VUH-2106)

The lead reported a 07:05Z alert for parent batch `1e9691ac` while its child
`539ab71f` was actively gating. On current main, VUH-2090’s scheduler removes a
completed failed parent from the active inventory before admitting its child.
The progress observer therefore reads the current child’s checkpoint and exact
command proof. No additional source tracking is needed on this tree.

The existing real CLI/API isolation test now ages the parent checkpoint past
three minutes. It proves that an isolation child held before command launch
still produces a stale-head observation naming the child, and that the child’s
real live gate suppresses the false parent alert. It then exercises the existing
active/waiting withdrawal fences and confirms the final exact-tree landing.
The targeted case passed before any source change: one passed, 22 skipped,
13.17 seconds. This is current-source evidence, not a live deployed alarm check.

This slice follows VUH-2099. Remote children continue to use its silence
observations and bounded execution; local children require their native process
identity proof. No automatic repairs, service restart or PC operation.

The [focused-check archive](clankie://evidence/sha256/016c3aee485536df6192edf5febf1baf9a519ef60af3220e8e3947c0cd471447)
retains that targeted run plus 33/33 integration and remote cases in 120.16
seconds, service typecheck, formatting and the regression patch. The test was
prepared on `cf61cc10a` plus pending VUH-2099, then only this regression was
rebased onto fetched main `8ae28f675` after that prerequisite landed. The copied
prerequisite commit is excluded from this slice.

[Fresh-main evidence](clankie://evidence/sha256/e869d6fcea5d9d2ad5da4d7d535321e88df48a4d1bfa8784e0cf1193a3935f2d)
records 33/33 focused cases in 94.68 seconds and service typecheck on that main.
The [prerequisite gate and push](clankie://evidence/sha256/97953339cd6326423aa00836a7f33c14b23fb2fddab98feb6680cce5aa39cbcb)
records VUH-2099’s authoritative exact-tree exit 0 and confirmed push; this
regression still requires its own integrate gate.
