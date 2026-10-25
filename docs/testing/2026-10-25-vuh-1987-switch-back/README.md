# VUH-1987: Clankie Work pilot drift, reconciliation and switch-back rehearsal

Clankie Work cut over from Linear to the built-in tracker on 2026-10-10 at
10:54:02Z (`tracker/cutover/active.json`). This record covers the pilot's state 15
days later: drift against the Linear copy, the reconciling writes, the step 4 live
read, and a switch-back plus re-cutover rehearsed on a scratch copy of the real
store. The live tracker, settings and convention were not changed, except for the
reconciling tracker writes listed below.

## Live state, 2026-10-25

- `clankie-work.trackerProjectId` is `cbd205ab-cad4-48b8-9724-7109410fc921`. This
  is the built-in project's id (`work project-details`) and also the Linear
  project's UUID. The convention is `builtin`. The webhook mirror was never enabled.
- The built-in store `fd877342` holds 82 issues: the 44 imported `VUH-n` plus 38
  `LOCAL-VUH-n` created after the cutover. It also holds 266 comments, 910 events
  and 839 pilot writes.
- The Linear copy was not frozen. Eight Clankie Work issues were written there
  after the cutover (VUH-1932, 1944, 1969, 1987, 2002, 2028, 2046 and 2047), and
  statuses diverged in both directions. These were callers hired into the
  `clankie` project, plus the lead's own tools, so VUH-2014's route-by-hire-project
  sent them to Linear. Filed as VUH-2829.

## Reconciliation (lead-approved, built-in only)

- Built-in was ahead on VUH-1944, VUH-2028 and VUH-2002, so no write was made.
- VUH-1932 and VUH-2046 show the same outcome on both sides. No write.
- VUH-2047 got a history comment linking the Linear-only landing and proof. Its
  status is unchanged, because Linear's 10-12 Done predates the lead's re-scoped
  acceptance on 10-17.
- VUH-1969 got a comment carrying Linear's 10-25 landing, Sage verdict and proof.
  Two writes were refused correctly:
  - `stage: landed`: the item has been delivered since the v0.4.0 release sync,
    and only the owner moves it back.
  - A new bundle: `bundle_locked`, because the owner must reopen it first.
    Lead closure through `clankie work close` was refused as
    `owner_verification_required` ("requires the current scoped lead"). The lead
    closes it from its own seat.
- VUH-1987 got an `ack` and is now `in_progress`.

Sync subscribe from bootstrap cursor 865 returned commits 866–870 for exactly
these writes, each with its actor and idempotency key. Refused writes appear as
commits with empty deltas. The partial bootstrap of `cbd205ab` holds all 82 issues
under that UUID, which is the binding the app's district projection reads. This
is the API the app calls, not a rendered screen.

## Switch-back rehearsal (scratch copy)

The `rehearse.ts` script (in the archive) drives the service's own `LinearCutover`
class over byte-for-byte copies of the live store, the cutover record (repointed
at the copies), the convention, and a settings file holding the real
`clankie-work` project. Nothing touches live paths.

1. **Switch-back, real:** `ready`, with 839 pilot writes reported.
   - The convention and the store match their pre-cutover backups byte for byte.
   - `trackerProjectId` is cleared, and the store is back to `89aa5025`.
   - The kept pilot file equals the seeded pilot store, and `active.json` was
     renamed to `switched-back.json`.
2. **What the switch-back loses:** the restored store holds none of the pilot's 82
   issues, 266 comments, 910 events, 49 bundles, 11 runs or 13 owner asks. The 38
   `LOCAL-VUH-n` items exist only in `pilot-<time>.json`. Nothing reaches Linear.
3. **Re-import, real:** `clankie work import linear --scratch
vuh1987-switchback-20261025` on the live service read Linear only (501
   requests) and wrote an isolated import store. A live cutover `--dry-run`
   against it did an independent fresh read (467 requests) and found 0 missing,
   0 extra and 0 stale across every type: 44 issues, 103 comments, 100
   relations, 45 labels. That dry run refused to apply only because the current
   cutover is active, the convention is `builtin` and the store holds records.
4. **Re-cutover, scratch:** applied from that import (store, setting, convention).
   The store is now the import's `032b3787` with 44 issues and 0 `LOCAL` items.
   The diverged items take Linear's state, for example VUH-2028 In Progress,
   VUH-2047 Done and VUH-2002 Backlog. **Gap:** the scratch run has no Linear
   credentials, and `clankie linear graphql` answered "No tool named
   linear_graphql in this lane". So this step's drift check read the import's own
   provenance and proves nothing on its own; step 3's live dry run is the fresh
   check.

Switching back after a pilot is therefore lossy. Port the pilot's own items by
hand from the pilot file, and expect a re-cutover to reflect Linear, not the pilot.

[Raw outputs, script and live captures](clankie://evidence/sha256/0d8f2b4caaf257dd5b1b63b7f97b5e7406e261e68fa2003944aff1c2669ca838)
