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

Moss resumed on main `4126ed0abe75fde868ec757f444b6224a2f6995c`. Both original
test files and the retained `play-voice.test.ts` runtime cases are byte-identical
to the baseline; the relevant model extension and room-event helpers are
unchanged. The before gate and 13/13 retained runtime proof are reused. Main's
new dependency required a frozen-lockfile install before the landing gate.
The different base and shared-machine/compiler-cache conditions prevent a
matched speedup claim.

Landed on main as `3ef50411dd49bf34e86a8eb0fb85ab169d3006dc`, cherry-picked
onto fetched main `6f7e23aa2139695a5abc45a2a5a632304b6c2a4f` after VUH-1948.
The fresh-checkout narrow run passed 16/16 (both touched files plus all 13
`play-voice.test.ts` runtime cases). The committed-head root gate passed
3/3 in both touched files, exit 0, sourceStable true, **131.711 seconds**.
All phases passed; Vox lint compiled fresh dependencies (85.156s phase)
and the service typecheck was uncached (21.280s phase). Final pull left
HEAD/base unchanged before push.

Moss's old-base after gate also completed: 3/3, exit 0, sourceStable true,
36.525s on `d4476f1e` against `4126ed0a`. It is preserved as earlier evidence;
landing acceptance uses the fresh-checkout gate. A premature narrow request
was canceled while queued before execution because dependencies were absent;
its SIGTERM/exit 143 trace is retained. The frozen install passed in 9.7s.

Final committed-head root gate and retained runtime results are recorded on
[VUH-1925](https://linear.app/vuhlp/issue/VUH-1925), together with the raw evidence
archive. Local receipts: `.local/vuh-1925/service-before-gate.json`,
`service-before-vitest.json`, `service-after-gate.json`,
`service-after-vitest.json`, `service-retained-vitest.json` and `service-counts.json`.
These shared-machine before/after values are single observations, not a claimed
repeatable speedup. The gate above did not reuse the service compiler cache.

Service conventional test source on the measurement base: 510 files,
157,294 → 157,270 lines. Rust inline production lines are not part of this count.
On resumed main: 511 files, 158,238 → 158,214 lines. The same two-file
24-line cut accounts for the change; upstream additions are not pruning savings.
At final landing: 512 service test files, 158,478 → 158,454 lines.

Running unit-pruning subtotal after this batch: five batches, 659 test lines and
38 cases removed. The schema fixture separately lost 50,178 lines with assertions
preserved. The inventory is incomplete; this is a batch result, not closure.

Raw before/after gates, narrow/runtime checks, logs, counts and the committed
diff are archived in the object listed in `evidence.json`. Raw bytes stay
outside git.

Archive: `clankie://evidence/sha256/1b8ff3ec7ed3baeb6ad185c9c23457c8e04b6adc24058f743bbac8b13986c076`.
Upload receipt is applied; [manifest](evidence.json) records its hash and size.
