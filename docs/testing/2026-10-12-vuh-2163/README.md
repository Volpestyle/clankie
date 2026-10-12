# VUH-2163: recover a failed test file before isolating a batch

Clankie's core queue landing gates finish the complete original Vitest selection, then rerun
only failed files, once each, serially on the same tree. A persistent failure,
unhandled/incomplete report, interruption, changed source or non-test failure
still blocks. Ordinary direct landing gates retain fail-fast behavior unless
`--retry-failed-tests` is explicitly supplied. Release CI retains its existing
two-flaky-file cap; merge-queue recovery has no additional flaky-file cap.

`repos[].gate.testRecovery` retains the first exit code, first test report,
flaky-file list and each rerun's result/report. Original phase failures stay
in the landing report. Local and remote gates use the same policy; remote
first-attempt and rerun reports are collected before remote cleanup. The private
app's gate has a separate parser and receives no unsupported retry flag; its
own retry policy remains a separate app change.

## Real batch proof

Run the committed [proof flow](flows/prove.mjs) from the repo root:

```sh
mkdir -p .local/vuh-2163
clankie heavy -- node docs/testing/2026-10-12-vuh-2163/flows/prove.mjs
```

The flow uses the actual IntegrationQueue and landing entrypoint, real Git
repositories/bare origins, frozen pnpm installs and real forked Vitest. Its
fixture package runs native Node syntax checks for its small non-test inputs;
this proves queue and landing orchestration, not all production-repo checks.
An actual filesystem barrier lets two requests coalesce. The intentionally
flaky assertion depends on its own file's execution counter; the persistent
scenario keeps the real assertion false. No commands or reporters are mocked.

- Shared batch `434af48b-18ab-4b60-aeb8-5fbeabba9695` checked both selected
  files. The failing file ran twice; the healthy file ran once. Its 1.49-second
  isolated rerun passed. Both members pushed to the local bare origin on the
  same composed tree, without member isolation. The batch records the flaky
  file and first-attempt exit 1.
- Shared batch `7365b334-54dc-4087-8dd1-27a9b50d3ed9` failed its 1.15-second
  rerun too. The batch stayed failed and member isolation ran. The broken
  member remained blocked; only the healthy member pushed.
- Initial fixture setup attempts failed on missing docs/skill inputs before
  Vitest. They stayed blocked with no test recovery. Those receipts are kept;
  the corrected setup produced the two proofs above.

Existing release retry contracts: 5 passed (54.48s), including the release cap,
repeated failures, hangs, skipped failed cases and incomplete/unhandled reports.
Existing remote gate contracts: 10 passed (97.55s). Real sibling installation,
main-move coverage and mixed isolation contracts: 3 passed (81.76s).
Protocol typecheck passed; service source and all test programs passed typecheck
(309.89s). Explicit touched-file formatting and lint passed. The merge queue
supplies the exact-tree landing result. No assertions, individual timeouts or
isolation changed.
The real core/app contract also passed with both repos using `check:landing`:
only core receives the retry flag (13.44s). The app follow-up is
[VUH-2166](https://linear.app/vuhlp/issue/VUH-2166).

Raw records, first reports, rerun reports and source snapshot are retained by
the evidence manifest, attached to [VUH-2163](https://linear.app/vuhlp/issue/VUH-2163).
The two underlying timeout fixtures have their own fixes:
[VUH-2164](https://linear.app/vuhlp/issue/VUH-2164) and
[VUH-2165](https://linear.app/vuhlp/issue/VUH-2165).

## Revisit when

Revisit if retries become frequent, a recovered result omits original coverage,
or a gate's repository adds phases after Vitest. Keep fixing flaky fixtures;
recovery only avoids paying for member isolation after a transient failure.
