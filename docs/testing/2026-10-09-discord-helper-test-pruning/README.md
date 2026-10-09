# Discord helper presentation pruning — VUH-1925

[Review reasons](../../adr/test-pruning-review.md#discord-helper-presentation-batch)
retain CLI JSON output, music body routing/author attribution/provider replies
and unreachable-body refusal. Removed detail is human table padding/wording
and the authored fallback sentence, with no product edits or new tests.

| Test file                                                  | Before lines/cases | After lines/cases |
| ---------------------------------------------------------- | ------------------ | ----------------- |
| `packages/discord-presence-core/test/check-report.test.ts` | 48 / 2             | 20 / 1            |
| `apps/clankie/test/discord-music.test.ts`                  | 55 / 3             | 54 / 3            |
| Total                                                      | 103 / 5            | 74 / 4            |

Baseline root `check:landing` used native `--changed` selection against fetched
main `3ef50411dd49bf34e86a8eb0fb85ab169d3006dc`. Temporary comment-only markers
selected the original files; removed before the cut. All five cases in both files
and every phase passed, exit 0, sourceStable true, **102.781 seconds**.
Both compiler tasks were uncached (72.135s phase); fleet admission wait is outside
the gate's reported elapsed time. Before/after values are single shared-machine
observations, not a repeatable speedup claim.

The focused check passed all four retained cases in both files, with no failures
or skips. The actual text writer output was inspected: PASS and FAIL status,
remediation and the not-ready outcome remain visible.

The cut landed as `70727e33165cffea3aa9ffdea86b30f42bb5c11b` on main against
fetched base `3ef50411dd49bf34e86a8eb0fb85ab169d3006dc`. Its committed-head
root gate passed all four cases in both files and every phase, exit 0,
sourceStable true, **62.034 seconds**. The two compiler tasks were uncached
(33.206s phase); tests took 16.518s versus 16.791s before. These runs do not
isolate test deletion from shared load and compiler effects. Final pull left
HEAD/base unchanged before push.

The push completed immediately before the owner changed VUH-1925 to PR-only
landings. This cut remains landed under the owner's instruction to preserve
already-landed batches. Its archive manifest and result update are submitted
separately for review; subsequent cleanup batches use PRs without worker merges.

Raw before/after root gates, narrow results, actual writer output, original
test source, counts and committed diff are archived on
[VUH-1925](https://linear.app/vuhlp/issue/VUH-1925).
Archive: `clankie://evidence/sha256/c954fe1096e26759b96431f352428d3cc715f88ba3e6434024f06b76b422f2cb`.
The applied upload's hash and size are recorded in the [manifest](evidence.json).
Local receipts are `.local/vuh-1925/discord-before-gate.json`,
`discord-before-vitest.json`, `discord-narrow-vitest.json`,
`discord-report-smoke.log`, `discord-counts.json`, and `discord-after-gate.json`.
The real writer is invoked with supplied PASS/FAIL checks, not a live Discord
readiness assessment. No real credential or body is contacted by that smoke.

Running subtotal: six unit-pruning batches, 688 lines and 39 cases removed.
The schema fixture separately lost 50,178 lines with assertions preserved.
Inventory is incomplete; this batch does not close the issue.
