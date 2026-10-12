# VUH-2149: direct TUI pruning

Slice 1: three incidental cases deleted and one existing formatter case merged,
with no product changes. Area: 155→155 files, 36,694→36,663 lines,
1,000→996 literal test registrations (parameterized registrations count once).
The 45 focused post-cut cases, TUI package typecheck, package lint and deadcode
including the actual service consumers all pass.

[Per-case reasons and retained boundaries](../../adr/test-pruning-review.md)
are the review. The cancelled queue variant and its earlier proof are historical;
the owner now requires these local package checks and direct main pushes.
No full test suite or evaluation runs locally. The archive manifest retains raw
reports and the narrow deadcode false-positive alongside the successful check.

Slice 1 landed at `2124e083bf7006079c0759f69c3862588a33f744`; its
[CI run](https://github.com/Volpestyle/clankie/actions/runs/38202449951) passed.

Slice 2 merges duplicate invite, model recognition and Herdr focus cases while
preserving their unique assertions; four other jump cases move unchanged.
Area: 155→154 files, 36,663→36,636 lines, 996→993 registrations.
The 59 focused cases, package lint, consumer-aware deadcode and final TUI
source plus all four test compilation partitions pass. Cumulative cut:
one file, 58 lines and seven registrations. Only tests and review/evidence
records change in either direct slice.
