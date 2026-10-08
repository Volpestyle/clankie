# Fleet journal lock contention — VUH-1852

The caller's 15-second watchdog included time waiting for the kernel journal
lock. It could kill a healthy queued request's helper before that helper acquired
the lock. The caller discarded stderr and reported only `Fleet resource lock
unavailable`; failed acquisition then removed the request's ticket.

The fix starts the watchdog only after the helper emits its acquired journal.
Contention waits under the same kernel lock without resubmitting a ticket.
Cancellation stops only the caller's waiting helper, discards cancelled unsent
mutations, and lets a sent write settle. Helper failures identify exit/signal and
the bounded native exception type/errno; arbitrary stderr, paths and journal
contents are not forwarded. The existing acquired-transaction deadline remains
15 seconds. Capacity, pressure policy, journal schema and admission order are
unchanged.

## Controlled trace

Baseline: `1b72a1a3f0f02d568abbedbc3d2d1d066c6cc0f9`. Fix:
`70efa99bb6b94dec9f47daf54af479ee3701ec10`. All tests run through the real outer `clankie heavy` permit, using
temporary fixture registries. Their one-slot fixture policy changes no live
registry. Actual Node wrappers, Python helpers, `flock`, journal writes and
command receipts are exercised; there are no mocked lock or process boundaries.

1. Start an owned holding command and enqueue eleven concurrent heavy wrappers.
2. Capture their eleven original tickets. Start another native helper and observe
   its journal reply, proving that it acquired this fixture's OS lock.
3. Keep the lock held for 17 seconds, longer than the old 15-second timer.
4. Check all wrappers are still alive and the journal's tickets remain identical.
   Release the native lock, then the owned command.
5. Check every queued wrapper exits zero, writes its command receipt, and leaves
   no queue or held capacity.

| Run                                                      | Observed result                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Baseline regression                                      | All eleven queued wrappers exited 1; the regression failed (20.33 seconds of tests).         |
| First fixed regression plus covering file                | 13/13 tests passed, including every queued command completing (55.01 seconds overall).       |
| Final package suite after cancellation/diagnostic review | 57/57 tests across five files passed (54.13 seconds overall); package typecheck also passed. |

The final suite also proves cancellation while waiting in the real OS lock,
discarding an acquired mutation cancelled before sending, distinct filesystem
and JSON-decoding error messages with no private path/content, and the retained
acquired-transaction deadline without writing the delayed mutation. Existing
FIFO, queued cancellation, orphan/group lifetime, registration, pressure and
simulator receipt checks passed.

Reproduce the controlled regression:

```sh
clankie heavy -- pnpm exec vitest run packages/fleet-resources/test/heavy-process.integration.test.ts -t 'keeps eleven queued'
```

Run the final covering checks:

```sh
clankie heavy -- pnpm --filter @clankie/fleet-resources typecheck
clankie heavy -- pnpm exec vitest run packages/fleet-resources/test
```

Decisive output: [baseline regression](evidence/baseline-lock.log) and
[final package checks](evidence/focused-final.log). Paths in copied output are normalized
to `<worktree>`; all test results are unchanged.

## Historical evidence and limits

Juno reported a queued install printing `waiting for machine capacity (load;
1/2 held, 7 queued)` followed by exit 1 and `Fleet resource lock unavailable`,
with no child output. The inferred wrapper was queued at 16:24:03.380Z; the
failure was observed before 16:27:47.621Z. That identity inference was not
independently proved. No saved log or native signal detail was retained.

Saga's saved log contained `waiting for machine capacity (load; 2/2 held,
2 queued)` followed by the same error, before Vitest started. Its file birth was
16:53:30.425215Z and last write 16:59:32.590301Z (362.165 seconds apart).
Both workers' ordinary retries succeeded. Neither historical trace can prove
the helper's exact exit, signal or lock-hold scheduling.

A read-only inspection of the pinned installed launcher confirmed that its store
still armed the same spawn-time 15-second kill and discarded helper stderr.
The controlled reproduction establishes that causal failure mechanism. The
historical reports are consistent with it, not proof of their exact cause.

No live slot policy, other lane's job, simulator, game body, deployment or restart
was changed or driven. Fixture cleanup uses only its own process receipts.

## Landing gate

`check:landing` passed with exit 0 on
`70efa99bb6b94dec9f47daf54af479ee3701ec10`, rebased onto fetched main
`1b72a1a3f0f02d568abbedbc3d2d1d066c6cc0f9`. Another pull after the gate confirmed
main had not advanced. Its preliminary checks passed: bundled Herdr skill,
repository/Rust format, repository/Rust lint, dead code, Markdown links, retired
claims, and 31 typecheck tasks (28 valid cache hits, three executed).

The selected test phase passed 281 files with nine existing skipped files,
2,698 tests with 26 existing skipped tests (290 files / 2,724 tests selected).
It started at 12:30:06 CDT on 2026-10-08 and lasted 297.56 seconds. No waiver,
retry, new exclusion, or live policy adjustment was used. The lead's earlier
temporary flake exception is retired; every gate failure blocks landing.

Exact invocation, with multi-package compilers serialized inside one permit:

```sh
clankie heavy -- env TURBO_BINARY_PATH=/Users/james/dev/clankie-wt/vuh-1852-rowan/.local/turbo-serial pnpm check:landing
```

The ignored local wrapper invokes the workspace's Turbo 2.10.4 binary with its
unchanged arguments plus `--concurrency=1`. Gate commands and test selection are
unchanged. [Decisive gate output](evidence/landing-summary.log) accompanies this
record. The subsequent evidence-only commit is checked with formatting, Markdown
links and retired-claim checks; it changes no tested runtime input.

The pinned installed launcher was not refreshed as part of this landing; live
adoption uses the normal authorized update path.
