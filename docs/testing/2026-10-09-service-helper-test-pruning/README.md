# Service helper test pruning — VUH-1925

Reviewed unit-only cut on main base `1d8ae045f89141536ff3e57247a0ce660422ae34`:
91 → 67 test lines; four → three cases. Product code, exports, fixtures and
E2E/integration/golden files are unchanged. See the
[per-file keep/cut review](../../adr/test-pruning-review.md#service-presentation-helpers).

| File under `apps/clankie/test/` | Before lines / cases | After lines / cases |
| ------------------------------- | -------------------- | ------------------- |
| `captain-model-card.test.ts`    | 60 / 2               | 53 / 1              |
| `play-execution-shared.test.ts` | 31 / 2               | 14 / 2              |

The first loses a wording-only case. The second loses an exact text assertion
while retaining its blank-event case and bounded overlay case. Runtime coverage
in `play-voice.test.ts` retains the meaningful reporting fields, room-owned
speech, journal provenance and lossless experience boundary.

The baseline root `check:landing` used its own native `--changed` selection.
Temporary comments selected both unchanged test files, then were removed before
the cut. Exit 0, sourceStable true, four passing cases in two files, 65.943s.
One uncached service compiler took 24.410s. Wrapper admission waited for fleet
capacity; that queue wait is outside the gate's reported elapsed time.

Resumed on main `7c1bc09b5ad7e0341072184d1913bd4ed3a2d987`. Both original
test files and the retained `play-voice.test.ts` runtime cases are byte-identical
to the baseline; the relevant model extension and room-event helpers are
unchanged. The before gate and 13/13 retained runtime proof are reused. Main's
new dependency required a frozen-lockfile install before the landing gate.
The different base and shared-machine/compiler-cache conditions prevent a
matched speedup claim.

Final committed-head root gate and retained runtime results are recorded on
[VUH-1925](https://linear.app/vuhlp/issue/VUH-1925), together with the raw evidence
archive. Local receipts: `.local/vuh-1925/service-before-gate.json`,
`service-before-vitest.json`, `service-after-gate.json`,
`service-after-vitest.json`, `service-retained-vitest.json` and `service-counts.json`.
These shared-machine before/after values are single observations, not a claimed
repeatable speedup. The after gate may reuse compiler cache; report that explicitly.

Service conventional test source on the measurement base: 510 files,
157,294 → 157,270 lines. Rust inline production lines are not part of this count.
On resumed main: 511 files, 158,238 → 158,214 lines. The same two-file
24-line cut accounts for the change; upstream additions are not pruning savings.

Running unit-pruning subtotal after this batch: five batches, 659 test lines and
38 cases removed. The schema fixture separately lost 50,178 lines with assertions
preserved. The inventory is incomplete; this is a batch result, not closure.
