# Command-picker test pruning — VUH-1925

Four mixed TUI files shrink from **2,332 to 2,123 test lines (−209)**.
Five incidental cases are removed; the other 80 original cases remain, with
presentation-only assertions pruned. No E2E, integration or golden test file
is changed or removed. No timeout, fixture budget or selector is changed.

| File under `apps/tui/test/` | Before | After | Removed |
| --------------------------- | -----: | ----: | ------: |
| `autocomplete.test.ts`      |    454 |   427 |      27 |
| `interactive-flow.test.ts`  |    295 |   230 |      65 |
| `provider-commands.test.ts` |    868 |   799 |      69 |
| `shell-assembly.test.ts`    |    715 |   667 |      48 |

The [ADR 0221 review ledger](../../adr/test-pruning-review.md#command-picker-presentation-batch)
records each file's cut and keep reasons. Keep command/alias resolution, the
Kitty key-release regression, keyboard selection/cancel/back/close, terminal
width, multiline owner input and secret masking. Initial selection is checked
by submitting it, rather than pinning a rendered marker or label.

Provider tests retain credential redaction and storage, hosted approval refusal,
actual persisted provider/model/effort values, unreachable endpoint fallback,
restart/provider intent and another face's later authoritative settings write.
The shell keeps failed and uncertain prompts without losing newer drafts,
steer/queue routing, streamed words, selected conversation IDs, close fallback,
fresh context, side-conversation restoration and server interrupt handling.

Cut preview palette/spacer/copy, outline glyphs, status-row alignment, fixed
auth-status tables and default slot labels, model presentation order, setup hint
copy, conversation label/copy arrays and a constructor/default-state snapshot.
The generic shell's duplicate ten-line tool-collapse assertions are removed;
its user, assistant, reasoning and notice content assertions remain. Real native
collapse/expand goldens remain in `native-tool-render-integration.test.ts`, and
actual startup frames remain in `fresh-page.test.ts`.

## Product code

**Export-only, no behaviour change:** `newestFirst` becomes private after its
sole external snapshot consumer is removed. Its internal runtime caller and
entire implementation body are unchanged. [The proof](export-proof.json) compares
the whole source file after removing exactly that one export modifier. Consumer
searches also covered the private app and ops source trees. `readinessFooter`
keeps its export because the real TUI entrypoint imports it. Knip stays active.

## Root gate measurements

Both runs use the root gate's own native `--changed` selection. They return
exit 0 and `sourceStable: true`. Neither is a zero-test clean-main pass.

| Run    | Gate wall time | Passed tests | Files | Serialized typechecks        |
| ------ | -------------: | -----------: | ----: | ---------------------------- |
| Before |        116.39s |           85 |     4 | TUI + service, both uncached |
| After  |         41.18s |           88 |     6 | TUI, uncached                |

These are **not matched speedup measurements**. The baseline checked HEAD
`536263c92` against newly fetched base `289bd0d9b`; that upstream change broadened
its compiler scope. The after run is rebased onto `289bd0d9b`; the export cleanup
adds the existing setup-command and guided-setup integration files to native
Vitest selection. Both guided-setup integration cases pass. Changing compiler
scope, selected tests and shared-machine load prevents attributing the wall-time
difference to pruning. Admission waits are excluded from gate wall time.

[Measurements](measurement.json) include exact HEAD/base/source fingerprints,
phase times, file selections, per-package/repository source LOC and sampled load.
Raw gate/Vitest/load receipts remain in the worker's ignored
`.local/vuh-1925/picker-{before,after}-*` files. One baseline admission failed
before child startup with the already-reported native lock `OSError (errno 9)`;
it is not a test or gate result. A later normal request completed successfully.

Retained higher-tier verification also passed unchanged: nine native rendering
integration/golden cases and three actual startup-frame cases, 12/12 across two
files in 1.21s of Vitest wall time. Receipt:
`.local/vuh-1925/picker-retained-vitest.json`. The raw native JSONL and captured
collapse/expand goldens were neither changed nor replaced with generated values.

The committed-head root gate, checked SHA, fixed base, retained native-golden
verification and push receipt are attached to [VUH-1925](https://linear.app/vuhlp/issue/VUH-1925)
after landing. The inventory remains incomplete; this batch does not close it.
