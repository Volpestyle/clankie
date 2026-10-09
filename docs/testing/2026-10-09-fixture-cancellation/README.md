# Fixture cancellation and full-run ordering (VUH-1938)

The lead bounded acceptance to the completed no-bail root run, one three-round
heavy-process comparison against the rebased main `501922c9`, then one root
`check:landing`. Each round starts the two arms simultaneously inside one
heavy permit, with `VITEST_MAX_WORKERS=1` per arm. Native EBADF remains unresolved.

## Causes and boundaries

- **Integrate and Google `ENOTEMPTY`:** root-run bail cancelled tests while their
  async bodies could still write. The original reports mark the room late-ack
  test skipped after 6.16 seconds and a Google case skipped after 1.13 seconds.
  Vitest 4 rejects its outer await on context cancellation without stopping the
  underlying async function. Integrate cleanup did not drain its queues or await
  service close; Google cleanup could remove credentials before broker children
  and pending operations finished. Suite temp roots are private; a shared temp
  directory is not established by this evidence.
- **Pet Stop 409/200:** the helper used a 150 ms timer to assume input admission.
  Under a different scheduling order, Stop could arrive before the HTTP input
  reached the queue. The helper now receives Stop permission only after the
  real host queue admission. The 409 and no-native-effect assertions remain.
- **Late room acknowledgment:** the parked retry poll had neither the test's
  cancellation signal nor an immediate rejection observer. Teardown could
  reject it while the test body was still waiting for watch setup. Both polls
  now observe cancellation immediately and retain their later awaited assertions.
- **Coalescing timeout:** the original full run timed out at 30 seconds while
  isolation passed in 10.67 seconds. Independent app conflict preparation was
  serialized before the first core-only gate could start. That preparation now
  overlaps the core gate startup, with the gate still parked at its actual
  barrier. The complete no-bail root run passed this case in 9.89 seconds.
- **Real fleet permit leak:** Ash 2 found four orphaned fixture drivers in the
  enclosing heavy runner's process group, retaining a real fleet slot. Their
  governor journals were private, but their process groups were inherited.
  Fixture wrappers now have separate groups and cancellation/teardown cleanup
  checks native process births before signalling owned groups. Native command
  receipts include their group so survivors can be stopped after runner death.
- **Simulator attribution fixture:** Node treated `--udid` as an unknown option
  because the argument lacked `--`. The parent script also contained that UDID,
  allowing accidental attribution to the parent. The parent now receives the
  UDID privately through its environment, passes it as a child argument after
  `--`, and waits for child-origin IPC readiness before the process census.

## Native lock error remains unresolved

The remaining native investigation is tracked as [VUH-1946](https://linear.app/vuhlp/issue/VUH-1946).

Moss observed two live admission failures with `OSError (errno 9)`, at about
08:06:21 UTC and exactly 09:09:24.225 UTC. Neither requested child started.
The second receipt is `picker-admission-failure.json` in Moss's VUH-1925
evidence; both errors preceded this diagnostic change. Ash 2's eleven-waiter
assertion captured one exit 1 but
did not include that waiter's stderr. FIFO did not change the native helper or
store locking code. The helper is single-threaded and owns its descriptors;
there is no demonstrated closed/reused descriptor cause yet.

Native errors now include a bounded operation name, with no paths, arguments or
journal data. The contention assertion retains failed-waiter output. Neither
change retries a failed admission or relaxes a deadline. Later successful
probes and an isolated pass do not prove EBADF is fixed.

## Verification

An iteration diagnostic passed 100 cases across six affected files. Changes
continued during iteration; that run is not acceptance evidence.

Real cancellation cases exercise Google HTTP refresh plus broker-lock cleanup,
and separate kernel process groups plus terminal children in a private heavy
journal. Focused checks passed 106/106 across seven files, with both affected
package typechecks passing. The coalescing case completed in 6.27 seconds.
The one complete root run on `3e0856e7` / base `536263c9` retained its actual
exit 1: 7,694 passed, four failed and 60 skipped, with stable source. All
original named cases passed; contention took 40.90 seconds. Failures were:

- The new private-group cancellation case encountered an uncertain native
  identity read after teardown started terminating its processes. Cleanup now
  waits for a confirmed native identity or exit within the existing wait bound;
  unknown is never treated as exited. The corrected cancellation case passed in every later affected-file repeat.
- The unchanged native-parent replacement case (already taken: true) exhausted
  its default one-second outbox-journal poll with `ENOENT`. Exactly that case
  passed alone on both head `3e0856e7` and base `536263c9` (one selected case
  each). That comparison does not establish a head-only regression or an
  isolated base failure.
- Unchanged cancellation/inherited-permit and managed-runtime-provider startup
  cases hit their 30-second test deadlines. They are retained as failures.

The first concurrent affected-file attempt retained 102/102, 102/102 and
101/102 results. Its inherited `VITEST_MAX_WORKERS=4` overrode CLI
`--maxWorkers 1`, allowing four workers per invocation. This was a runner
concurrency mistake, corrected by setting each child's `VITEST_MAX_WORKERS=1`.
The third invocation's stale-incarnation command exited 1 instead of 23,
without its captured stderr in the assertion. The cause is unproven; three
focused repeats passed with the corrected environment limit. The assertion now
awaits stderr drainage and includes that output on failure. These isolates do
not establish a fix for the earlier exit. All original named cases and new
cancellation cases passed in each first attempt.

The corrected concurrent affected-file repeats retained 102/102, 102/102 and
101/102. The third failure occurred before the termination test could observe
its initial command receipt; termination had not been sent. The assertion now
reports drained command stderr and private admission queue/phase on this boundary.
All original named cases and cancellation cases passed in all three repeats.

The final paired experiment used fixed main `501922c9` and head `3b59bc46`.
Both arms started within one millisecond in each of three sequential rounds,
with one Vitest worker per arm inside one heavy permit. Base passed 12/12 and
head passed 13/13 in all three rounds; source remained stable. The additional
head case exercises private-group cancellation. Before/after load samples were
healthy (0.59–1.45 per core), with 52,369–54,754 MiB available; these samples
do not establish per-case peak load. The paired run detected no head-only
failure, but did not reproduce or establish the cause of the earlier startup
flake. That gap is tracked as [VUH-1956](https://linear.app/vuhlp/issue/VUH-1956).

The first control attempt had already admitted against `909ee29b` when the
lead corrected the base to `501922c9`. Its source changed during the second
round; the scheduler stopped before round three, existing children finished
and owned groups were cleaned up. That attempt is discarded evidence, never
acceptance. The corrected three-round experiment above used a fixed base.

The root landing gate result is attached to [VUH-1938](https://linear.app/vuhlp/issue/VUH-1938)
with its actual exit, checked HEAD, fixed base and stable-source result.
Earlier failed full/repeat runs remain failures in the evidence manifest.
No timeout raises,
new skips, manual evals, live capacity edits or simulator boots are part of this
work.
