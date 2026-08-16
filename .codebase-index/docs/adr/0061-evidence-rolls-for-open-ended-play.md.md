# docs/adr/0061-evidence-rolls-for-open-ended-play.md

The adapter's evidence window gets a policy:
`frozen` (overflow marks the session uncertain —
correct for deterministic receipt runs) vs
`rolling` (windows seal and restart with
`rolledWindows`/`droppedEvidenceEvents` counted —
what free play uses).

Read for the incident it fixes: a marathon
session died permanently at ~256 actions because
receipt rules were applied to open-ended play.
The body never stops because a ledger filled;
uncertainty is reserved for actual state
uncertainty; caps are confessed, never silent.
