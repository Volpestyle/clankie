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
