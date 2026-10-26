# VUH-2872: unrelated unknown owners and lost close settlements

Source fixtures only. No runtime update, restart, settings or credential change,
real tracker write, or native pane closure. Deployed acceptance is recorded
separately on [VUH-2872](https://linear.app/vuhlp/issue/VUH-2872).

## Cause (traced on `e2f2ddde0`)

- `settle()` called `resolve()` on every `unknownOwners` seat before checking
  that seat's keys. A worker whose roster capture threw
  `Native hire attribution is unavailable or changed occupant.` failed every
  close that had no known live owner, including closes of unrelated issues.
- `closed()` and the exit-grace path removed the seat before settling, so a
  failed settlement was dropped without a retry.

The culprit seat in the 2026-10-26 live repro is still unknown, because
`unknownOwners` lives only in memory.

## Change

- Unknown owners: each key is canonicalized in the retiring item's own verified
  scope. If every key names a different item, the seat cannot own the target in
  that scope, and existing semantics already exclude other scopes. It is skipped
  without consulting its attribution. A key that names the target, or cannot be
  resolved, still needs the seat's fresh attribution, and a refusal defers the
  settlement (VUH-2817 fail-closed).
- Retention: a failed close or exit settlement keeps its original outcome,
  evidence and attribution in memory. It returns `retryUntil` and is retried in
  later roster rounds, backing off from 30 seconds to five minutes for six hours.
  The plan is frozen before the first external effect. A retry re-resolves
  scope, refuses a changed one, re-reads the status before writing it, and reads
  the comments back after an uncertain post. When the bound is reached, the
  result says the issue must be settled by hand. A seat that returns with
  confirmed attribution for the same item drops its unstarted retirement.

## Proof

`apps/clankie/test/seat-issue-settlement.integration.test.ts` runs the production
`SeatIssueKeeper`, `ProjectHires` ledger, `prepareSeatIssueAttribution` and
built-in project tracker routes over disposable stores. Refusals are real
changed-occupant captures.

| Case                                                             | Result                                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Unrelated unknown owner (`LOCAL-VUH-2`, changed occupant)        | close of `LOCAL-VUH-4` settles; peer attribution not consulted                                       |
| Relevant unknown owner (same item) and unprovable key (`NOPE-9`) | deferred with `retryUntil`, store bytes unchanged through backoff                                    |
| Recovery after close                                             | roster catches up; retry hands off with original reason and evidence, one comment                    |
| Changed occupant                                                 | refusal on the same item defers; never credited as successor                                         |
| Identical keys in distinct scopes                                | B's `LOCAL-VUH-4` defers A's close until B is attributed; then A settles, B unchanged                |
| Exactly-once                                                     | injected lost reply after an applied comment; retry reads it back, no second comment or status write |
| Bound / return                                                   | retries end after six hours with a hand-settle detail; an undone seat's retirement is dropped        |

The four new tests fail on the original source. Disabling the comment read-back
fails the exactly-once case. Existing `seat-issue-status` and `seat-issue-scope`
suites pass unchanged (14/14 together). `@clankie/clankie` typecheck and scoped
lint pass.

Gap: retained retirements do not survive a service restart. The daily
In Progress check still lists such an issue for the lead.
