# Fixture cancellation and full-run ordering (VUH-1938)

Work in progress. This archive does not yet establish the required three
consecutive full no-bail root passes or a resolved native EBADF cause.

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
  barrier. Repeated full-run results are needed to assess this change.
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

Moss observed one admission failure with `OSError (errno 9)` at 08:06:21 UTC;
Vitest never started. Ash 2's eleven-waiter assertion captured one exit 1 but
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
Three consecutive complete root Vitest runs with `--bail 0` and the mandatory
root `check:landing` are pending. No timeout raises,
new skips, manual evals, live capacity edits or simulator boots are part of this
work.
