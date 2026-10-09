# Simulator FIFO: VUH-1923

Simulator acquire now persists a ticket in the machine resource journal before
waiting for capacity. It records the live native process birth, seat/occupant,
task holder, original device or model/runtime, exact flag, resolved existing
target, creation time and stale deadline. A grant consumes the front ticket for
that device atomically with its pinned reservation. Other device queues and the
heavy FIFO are independent. Existing global memory/load guards still apply.

The CLI sends one blocking acquire POST, with a one-hour default and a bounded
`--wait` option. It no longer repeats plan/acquire while waiting. The server
waits on the same ticket, waking on resource changes and periodically checking
the journal for pressure, expiry and other processes. API `waitMs: 0` returns an
immediate ticket receipt; `ticketId` resumes it with the same selection. Exact
requests wait for their target rather than substituting or creating a replacement
for a busy existing device. A changed selection requires cancelling first.

The proven holder can cancel its own ticket. Active waits renew a five-minute
stale deadline; expired tickets and proven dead process births leave the queue.
Unknown native observations do not establish exit. Tickets persist across service
restarts and never authorize driving a device. A client wait abort cancels only a
pending ticket; admitted preparation and its lease remain service-owned.

`fleet resources` reports the target, position, expiry and wait estimate. The
estimate is a heuristic from the current holder's remaining idle budget and one
idle budget per earlier ticket. Heartbeats can extend it. Pressure or insufficient
occupancy information reports null, not a promised deadline.

## Queue contract checks

Three new integration cases cover three ordered holders across releases with
blocking HTTP acquires, persistence across restart while another device and a
heavy command proceed, and holder-only cancellation, immutable selection and
stale expiry. They cross real HTTP, the OS-locked journal, process birth checks
and the existing child-process simctl fixture. The CLI route check verifies that
an external device can become available while one acquire POST remains blocked.
No live simulator was acquired, booted or driven for this change.

Initial queue cases passed. Intermediate runs caught a strict plan-schema bug
(wait-only fields incorrectly sent to plan), a fixture cast and outdated polling
expectations; these were corrected. A later focused run was 63/64, with a grant
validation consumer returning stale_owner during high host load. That result is
retained as a failure, not accepted as a timing exception for affected code.
Final root-gate and rerun results must be recorded before landing.

Raw logs and pressure responses stay in ignored `.local/vuh-1923/` in the owned
worktree. No live settings, fleet notes, capacity, harness sessions, simulator
services or deployment were changed. Stopping repeated caller acquire attempts
is proved at the HTTP boundary; an Auto-Mode classifier live trial is outside
this tests-only assignment.
