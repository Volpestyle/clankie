# Worker report destinations (#347)

A worker may choose a report destination without changing who leads it. Omitting
`target` retains the existing hiring, adoption and native ancestry routing.
An explicit destination never falls back to that route.

The service lists only destinations recorded for the exact native occupant in
its persisted hire record. Its current lead and original hiring lead are named
by that record; the owner can add another existing private global/workspace lead conversation or connected
lead app. A worker cannot add destinations, adopt itself, change its role, or
turn its report text into owner instructions. Connected leads receive only the
reports addressed to them, not control of the reporting worker. Connected app destinations also require the owner's existing Apps lead mode;
a report grant does not raise that independent ceiling. Structured
approval requests use the ordinary default report route to the worker's
current lead; an explicit destination receives the report text without a
service-issued approval card.

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

The owner uses `clankie fleet report-leads PANE` to read the exact native hire's
destinations, `grant CONVERSATION [APP_DEVICE [REF]]` to add a destination, and
`revoke TARGET` to remove one. The same owner-only API is
`POST /v1/fleet/report-leads`. It requires this machine's owner operator credential; native workers and
connected app/device credentials cannot use it. Existing
journals without the new original-destination capture expose only their current
lead and, while still leading that exact occupant, their hiring app. Historical
display attribution alone is never upgraded into permission.

Workers call `list_report_leads`, then `message_clankie {text, target, kind}`.
Explicit destinations retain reports in the selected inbox; the hiring app's
wake settings continue to describe ordinary default reports.

The listing includes the conversation scope (including workspace and machine
when present), title and app/ref for an app destination. IDs are opaque; do not
construct one from a name. Joined-machine workers using their separate joined
worker API still report to their hiring chat; this API does not add grants to
that separate hire registry (follow-up [#876](https://github.com/Volpestyle/clankie/issues/876)).
