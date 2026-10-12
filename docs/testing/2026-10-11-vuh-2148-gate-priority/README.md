# VUH-2148: merge-queue resource priority

Local batches now acquire one service-owned full permit for installation and
landing gates. Gate tickets precede ordinary full jobs, in FIFO order between
gates. New light jobs and simulator reservations or boot submissions wait while
a gate is queued or running. Existing holders finish; server admission and
resource guards remain in place. No assertion, timeout or Vitest isolation
setting changed.

## Proof

The focused priority integration test runs real child processes, native
supervisors, process-birth observations, journals and OS locks. Its pressure
input is controlled at the existing data boundary. Both the service arbiter
and fallback admit two gates ahead of an older ordinary job, hold a light job
and simulator boot submission, preserve an existing reservation, and restore
ordinary admission after the gates finish. Cancellation removes queued gate
priority. The surrounding check itself uses the live governed resource lane.

- Priority and fixture-pressure policy: 10 tests passed, 7.22 seconds.
- Native processes, light lane and arbiter: 27 tests passed, 117.13 seconds.
- Existing full-progress guard coverage: included in the initial six passing
  priority/full-progress tests (9.32 seconds).
- Real sibling installation, private gates and durable exact-HEAD reload:
  existing integration contract passed (17.98 seconds).
- Mixed-isolation retries: passed (29.82 seconds). The first run exposed a new
  runner regression that stopped after the first failed gate; the driver now
  continues remaining gates and retains their results. The failed log is kept.
- Fleet-resource and service typechecks passed; explicit touched-file formatting
  and lint passed.

These are focused checks, not a green repository landing gate. The merge queue
supplies the exact-tree landing check. Actual loaded-machine gate timing remains
to be measured after the updated service and workers enforce priority. The
controlled-pressure proof above must not be described as that measurement.
Older clients can read the version-1 journals, but cannot enforce new priority.

Raw receipts, including the initial failed check, are in the accompanying
evidence manifest. See [VUH-2148](https://linear.app/vuhlp/issue/VUH-2148).

## Revisit when

Revisit if remote gates need the same service-owned admission, gate starvation
delays ordinary work, or resource measurements show exclusive gate admission
underuses the machine. Change guards only with new measured evidence.
