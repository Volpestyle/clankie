# TUI incidental-test pruning — VUH-1925

Five mixed test files shrink from 626 to 419 lines (−207), with 42 cases reduced
to 23. The TUI test-source total is 35,990 → 35,783 lines; repository conventional
`.test`/`.spec` source is 245,162 → 244,955 lines. These counts exclude fixtures,
inline Rust source and documentation. This is one reviewed batch, not a finished
inventory.

The [review ledger](../../adr/test-pruning-review.md) names each cut and retained
contract. Native tool-render integration and its VUH-1661 goldens, restored-history
frame ordering, actual terminal-width limits, ASCII-only fallback, session reuse
and safe transport refusal remain. No E2E, integration or golden case is removed.

## Source visibility

The deleted snapshots were the sole external consumers of six helper functions
and one type. Knip correctly blocked the first cut. The lead approved removing
their export modifiers: **export-only, no behaviour change**. Their complete module
text equals the original after removing precisely those seven modifiers; bodies
and runtime callers are unchanged. Consumer searches across this repository and
the private sibling source trees found only internal calls. There are no new
Knip exemptions or replacement snapshots. [Export proof](export-proof.json).

## Gate measurements

Before pruning, factual comment-only edits forced the five original files into
the native root `check:landing --changed` selection against
`6691c907ccdcaeed4abbcd093da6971a22f68162`. The gate passed in 39.23s with all
42 cases selected. The original TUI typecheck was uncached.

The first cut failed at Knip (12.41s). After the approved export cleanup, Knip and
both uncached compiler checks passed, but the root gate failed in 139.98s:
`discord-setup-integration.test.ts:370`, “the real CLI connects a server and role,
toggles fleet and selects tracking without room lists or machine grants”, timed
out at 30,000ms. Its result was 219 passing, one failing, six not run under the
root gate's bail policy. This failed run remains evidence, not a green gate.
A post-run load sample was approximately 94.6/18 cores; it was taken after the
failure, so it does not establish causal attribution.

Export visibility changes widened native selection from five to 28 files and
from one to two compiler packages. Consequently these times are not a matched
speedup measurement. Heavy admission wait is excluded from gate wall time.

## Isolated diagnostic

The exact timed-out Discord setup case passed alone in 18.46s on unchanged
product/test inputs (one passed, nine unselected). This is diagnostic evidence,
not a replacement for the root gate. The case imports affected TUI modules, so
this batch does not invoke the exception for timing failures outside affected
imports. The full-package acceptance result is recorded below. The final committed root
landing-gate receipt, checked SHA, fixed base and after wall time are attached to
[VUH-1925](https://linear.app/vuhlp/issue/VUH-1925); its raw report is retained in
`.local/vuh-1925/tui-final-gate.json`.

## Retained additional attempt

An optional full-package run on the old base finished in 139.14s: 1,219 passing,
seven failing, two skipped. It was invoked from `apps/tui`, which made four
repository-relative fixture assertions fail (sandbox source resolution and
branding paths). Two other assertions already have structured-result repairs on
current main (`68f1bde84`, `7168a385f`). One unchanged Discord CLI revision-fence
case timed out at 30,000ms. This attempt is retained and is not acceptance evidence.
The retry uses the repository root and rebased main. A preceding queued attempt
never started because the heavy lock helper returned `OSError (errno 9)`.

## Rebased full-package acceptance

On `e7ecba8fd` rebased onto `c2dd9b67f`, the root-CWD full TUI run passed:
151 passing files, one existing skipped file; 1,226 passing tests, two existing
skips; 113.56s Vitest wall time. All reviewed files, native tool-render goldens,
restored-history frames and the retained integration coverage passed.
No assertions, timeouts or product defaults were weakened to obtain this result.

[Measurements](measurement.json) preserve the baseline and failed root attempts,
plus the successful full-package result. The initial line-count comparison uses
the same `6691c907c` baseline; subsequent unrelated main changes are not attributed
to this pruning. Gate wall time excludes heavy admission wait and is not a
matched performance experiment because export cleanup changes native selection.
