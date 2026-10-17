# Integration fixture admission and cancellation

The [v0.4.5 release run](https://github.com/Volpestyle/clankie/actions/runs/39018406704/attempts/1)
reached its 65-minute macOS job limit in `integrate.integration.test.ts`.
Repeated cases took 60–90 seconds, retained empty gate-runner logs, and left
earlier fixture roots present. The interrupted run did not produce a completed
Vitest report; its uploaded `tests.xml` is empty.

A local unchanged-input run with `CI=1` reproduced the first case's empty log.
The fixture registry had one queued gate, zero leases, load ratio 4.808, and
19,903 MiB available memory. Admission correctly refused the busy host. The
test's abort signal stopped its Git helpers but did not reach the governor's
queued gate. Teardown then drained `queue.wait()` before it could close the
governor, so cancellation could not finish and later roots accumulated.
This local observation proves the cancellation defect; CI did not retain a
pressure snapshot that could identify its exact admission refusal.

The local and remote-fallback fixtures now own real governors in their scratch registries, with a fixed
load/CPU/memory probe. Its surrounding check retains the real host permit;
Git, native runners, process identity, locks, journals, and disk checks remain
real. Governor work combines the fixture lifetime with any caller abort signal.
Production policy, timeouts, and existing assertions are unchanged.

## Regression proof

The new case queues an actual gate by setting the fixture's memory floor above
its fixed observation, expires the fixture, and requires the tracked wait and
resource queue to drain before explicitly closing the governor.

- Without the fixture signal binding: the cancellation assertion failed;
  `/tmp/clankie-v045-fixture-cancel-red.log` (exit 1, 8.87 seconds).
- With the binding: 1 passed, 36 unselected;
  `/tmp/clankie-v045-fixture-cancel-green.log` (exit 0, 6.71 seconds).
- Complete local integration file with `CI=1`: 37 passed;
  `/tmp/clankie-v045-fixture-full-green.log` (exit 0, 238.68 seconds).

The final shared helper and both fixture files are selected by the root landing
gate, retained in `/tmp/clankie-v045-fixture-landing.log` and `.local/landing-gate.json`.

## Retained evidence

- CI [QA artifact](https://github.com/Volpestyle/clankie/actions/runs/39018406704/artifacts/12097372206).
- Complete CI job log: `/tmp/clankie-v045-macos-final.log`.
- Unchanged-input local reproduction: `/tmp/clankie-v045-ci-integrate-repro.log`.
- Actual local queued-admission snapshot:
  `/tmp/clankie-v045-ci-integrate-repro-pressure.json`.

The v0.4.5 tag remains fixed. The lead authorized one rerun of its failed macOS
job; if it also fails, the corrected release will use v0.4.6.
