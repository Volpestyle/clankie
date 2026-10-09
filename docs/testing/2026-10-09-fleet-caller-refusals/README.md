# VUH-1941: caller attribution and the loaded-host refusal trace

The authenticated fleet metrics response now includes bounded, five-minute
`callers` windows keyed by `claimedPane`. These labels are diagnostic request
claims, not caller authentication. Invalid/missing labels and overflow remain
in aggregate counters. A worker alert includes its pane and observed harness
at the existing owner-route check; recipient/binding guards are unchanged.

## Trace finding

Read-only service-log join, 2026-10-09 08:43–08:49 UTC, covering the reported
08:48:23 alert: nine `native_initial_unavailable` terminal refusals belonged to
one caller pane. Each request joined to an initial `ancestry_unavailable`
diagnostic, errno 3 (`ESRCH`), attempt 1, `retry:false`. None of those nine
request IDs joined to `budget_exhausted`.

Four budget-exhaustion diagnostics in the same interval belonged to four
_different_ request IDs: three initial checkpoints and one final checkpoint,
all attempt 1 with `retry:true`. No terminal refusal context matched those
four requests in the interval. Diagnostic counts alone therefore did not
establish that budget exhaustion caused the reported refusals.

The native helper reports `ancestry_unavailable` when observing a socket owner's
process chain fails. A budget expiration sets `budget_expired` and emits
`budget_exhausted`, which also marks the ancestry refusal retryable. The nine
non-retryable ESRCH observations took a different path. Logs do not identify
which ancestor vanished or became unobservable; they cannot establish that
load itself caused these ESRCH failures.

**No budget or admission change.** The 200 ms scan / 600 ms total caps, owner
birth/socket pins, ancestry validation and final revalidation remain unchanged.
There is no new acceptance fallback for a non-member or unavailable observation.
Raw request IDs and process attribution are kept in the owned worktree's ignored
`.local/proof/trace-private.json`; this public note contains only counts/stages.

## Acceptance checks

The existing real-TCP fleet metrics/CLI integration checks two caller windows,
aggregate coverage for an invalid claim, authenticated access, and expiry.
The existing fleet-lead integration checks delivered alert text naming the
pane and harness, including the parent-owned route. Root `check:landing` is
the landing gate; its result is attached to VUH-1941.
