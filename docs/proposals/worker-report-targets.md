# Worker report destinations (#347)

A worker may choose a report destination without changing who leads it. Omitting
`target` retains the existing hiring, adoption and native ancestry routing.
An explicit destination never falls back to that route.

The service lists only destinations recorded for the exact native occupant in
its persisted hire record. Its current lead and original hiring lead are named
by that record; the owner can add another existing conversation or connected
lead app. A worker cannot add destinations, adopt itself, change its role, or
turn its report text into owner instructions. Connected leads receive only the
reports addressed to them, not control of the reporting worker.

An explicit target is part of the original delivery fingerprint and unresolved
receipt journal. Reconciliation reads that original and cannot retarget it or
resend it. Revoking a destination prevents new reports; it does not erase an
already accepted report or make a lost receipt replayable. Native occupant
replacement cannot inherit another occupant's grants.

Verification uses an isolated real worker bridge, linked HTTP admission path,
persistent hire journal and service report inbox. It covers another permitted
lead, a definite unauthorized refusal without fallback, unchanged default
routing, native replacement, owner-only grants and lost-response recovery.
No live Discord or model calls are needed.
