# Auto drift correction (VUH-2285)

The shared `record_drift_correction` lead tool records a chosen issue and one-line
reason beside the detection in its original Auto round. Current Auto-project
ownership and host-stamped conversation authority bound every write. Exact retries
retain the response; a different choice belongs to a later drift round. Service
turns, native seats and delegated remote leads share the authored tool.

The following measurement reads the existing tracker outcomes/history and origin
churn: did that issue reach a started state, and did product churn land after the
response? Unresolved or unreadable checks stay in subsequent normal rounds. Only
a delivered, satisfied check resolves the pending response. Churn is project-wide
evidence, not attribution of those lines to the chosen issue. No status-line or
TUI work from VUH-2284 slice 2 is included.

## Inspected proof

`isolated-runtime.json` is the actual `clankie auto rounds` response plus the
native-channel wakes captured by the integration proof. It runs a real captain,
HTTP API, CLI, built-in tracker, local origin and native event poll/ACK with no
model calls or external project writes:

1. A completed working day with no owner-facing closure produces `nothing_closed`.
2. The owning lead records the playable milestone issue and reason; the same
   round shows both detection and response. Another conversation is refused;
   exact retries retain the first choice and a different replacement is refused.
3. The following round reports `unresolved`: the issue has not started and zero
   product lines landed after the response. Earlier product scaffold is excluded.
4. The tracker issue starts and real product code reaches origin. The next round
   reports `satisfied`, with `issueStarted: true` and positive `productLines`.
5. The actual CLI returns the same parsed round record as the API.

The companion real tracker/origin integration covers response persistence across
restart and unreadable tracker/repository checks staying unknown. The remote MCP
boundary retains project-tool narrowing and exposes the new tool; no live Windows
native process is claimed by that test.

## Validation

- Focused integration/MCP-schema run: **45 tests passed**, four files.
- Isolated runtime capture: **1 passed**, five unrelated tests skipped.
- Protocol typecheck: passed. Service typecheck and root landing gate: pending
  at initial evidence capture; final landing evidence follows on the issue.
- Independent bounded diff review: no findings; no reviewer edits or test reruns.

## Live scope

The latest deployed records inspected at implementation time had KH2's
`tooling_lead` wake refused (`2026-10-15T20:41:38Z`) and no drift in Clankie's
accepted round. Therefore this artifact proves the correction cycle in an
**isolated runtime**, not a live project response or owner acceptance. No drift,
usage reset or owner project state was manufactured for live proof.
