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

These initial checks were focused. Subsequent exact-tree landing and live
post-deployment timing are recorded below. The controlled-pressure proof
above is distinct from that live measurement.
Older clients can read the version-1 journals, but cannot enforce new priority.

After VUH-2163 landed, the supervised local driver was aligned with its core
retry flag and durable recovery records. Real two-member batches through this
driver recovered a failed file without isolation and blocked a repeated failure.
The existing core/app flag contract passed; a mixed-isolation fixture first
failed waiting for its initial barrier and then passed alone (28.75s), retaining
the failed log. The earlier full priority gate failed its real CPU sampler
assertion; that unchanged case passed alone (811ms). Neither isolated pass
changes the earlier full-gate result. The subsequent exact-tree request `602268c1-5fa4-466f-b737-a30f26b9ea67`
passed 6,468 tests (674.23s test wall, 1,014.39s root gate) and pushed
confirmed exit 0 at `bd64bfb86`. The lead deployed it in `37e8a04bf`
at 09:50:38Z on 2026-10-12.

The [live capture](../2026-10-12-vuh-2148-live/README.md) records the next
real batch: one permit across its 11.870s install and 446.746s gate.
New full/light jobs waited despite spare capacity, then resumed after the
gate. Its selection and host load differ from earlier gates; this proves
admission and actual timing, not a controlled speedup. The separate native
proof covers simulator reservation and boot-submission priority.

Raw receipts, including the initial failed check, are in the accompanying
evidence manifest. See [VUH-2148](https://linear.app/vuhlp/issue/VUH-2148).

## Revisit when

Revisit if remote gates need the same service-owned admission, gate starvation
delays ordinary work, or resource measurements show exclusive gate admission
underuses the machine. Change guards only with new measured evidence.
