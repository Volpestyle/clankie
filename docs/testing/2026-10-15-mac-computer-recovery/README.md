# Local Mac computer owner recovery — VUH-2313

Tracks: https://linear.app/vuhlp/issue/VUH-2313

Peekaboo 4.3.0 exposes active-request status but no native queue drain receipt.
Ordinary recovery still refuses without stop proof. The new local-Mac-only
`recover.ownerRecovery` decision accepts that uncertainty explicitly under fresh
operator authority, with a reason and the expected holder and expiry. It requires
an actually expired claim, no service-tracked holder work and no computer operation.
An exact incarnation fence survives awaited authorization; a synced decision audit
precedes release. Windows and joined screens cannot use this exception.

## Focused evidence

`clankie heavy -- pnpm exec vitest run apps/clankie/test/computer-recovery.integration.test.ts apps/clankie/test/body-recovery.integration.test.ts apps/clankie/test/joined-screen.integration.test.ts --disableConsoleIntercept`

**34/34 tests passed**, exit 0, 29.25 seconds. The new tests exercise the real HTTP
route, CLI, bearer verification, persistent lease/journal and conversation turn
tracking. Unrelated app ports use the existing stub; no native desktop input or
daemon stop is performed. The existing joined tests use their explicitly synthetic
native provider through the real encrypted join carrier.

- An expired native-held Mac claim refuses ordinary recovery with actionable
  guidance, then releases through the explicit operator decision. The audit names
  its reason, original claimant and operator. A fresh acquire/release succeeds;
  reopening the real lease store preserves that result and its audit.
- Unauthenticated calls, empty reasons, stale expectations and native/tool
  identities without independent operator authority refuse.
- Real service turns, pinned body operations, concurrent recovery, changed or
  revoked operator authority and replacement during an awaited guard cannot
  release the protected claim.
- An unwritable audit or persisted partial JSON tail retains the original claim.
  The audit is an authorized decision, never a false successful-release receipt.
- Windows refuses the Mac override. The joined API refuses it without adding
  native stop/input actions; its existing native-drain recovery contract remains.
  Automatic recovery still refuses native holders.

Independent native review found the partial-audit risk; strict audit validation
and its persisted regression fixed it. Final review reported no remaining blockers.
The log retains earlier corrected compatibility failures as well as the final pass.

## Remaining proof

The required root landing gate and deployed recovery/fresh-acquire result are
attached to the issue separately before closure. These focused tests alone do
not prove the live stuck lease cleared or that Peekaboo input drained. No evals ran.
