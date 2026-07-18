# VUH-698 live ceremony evidence — 2026-07-18

Both decision paths were exercised live in the minimal console (`@clankie/tui`,
`/approvals` inbox) attached to the interactive drill's control plane. The
operator identity is the control plane's configured `local-operator`; the
session record of who drove the console lives in the
`2026-07-18-close-wave` run manifest.

## Reject path (drill runtime `…-ZKIQTO`, mission `mission-0626af68-209`)

- Pending `github.pr.merge` (`merge-151f33adbe5f91d6`) surfaced in the console
  inbox with plan, runner evidence bundle (SHA-256s, artifact refs), and policy
  rationale; evidence inspected in the console before deciding.
- Denied with reason: "Ceremony reject-path check: sending back for one more
  verification pass before merge."
- Audit (hash-chained, 27 events verified): `approval.requested` seq 26 →
  `approval.decided` seq 27, `status: denied`, `decidedBy: local-operator`,
  `decidedAt: 2026-07-18T18:50:57.877Z`, `profileHash: 56c8aad9d3445cb6`.
- Lead re-request returned `effect=deny`,
  `matchedPolicyIds=["operator-approval:denied"]` with the operator reason
  attached; no connector executed. The lead must replan.

## Approve path (drill runtime `…-V5zKD7`, mission `mission-4f222c04-3fa`)

- Fresh pending merge (`merge-5c62f28bcf204cef`); boundary held before the
  decision (re-request still `require_approval`).
- Approved in the console with reason: "Reviewed runner evidence bundle (hashes
  verified, checks passed, independent sim verifier); approving the simulated
  merge for the M2 ceremony."
- Audit: `approval.requested` seq 26 → `approval.decided` seq 27,
  `status: approved`, `decidedBy: local-operator`,
  `decidedAt: 2026-07-18T18:52:43.382Z`, `profileHash: 56c8aad9d3445cb6`.
- Only after the recorded approval: `effect=allow`,
  `matchedPolicyIds=["human-approved-merge"]`, then
  "privileged connector: simulated merge executed" (no real remote).

Both drill runtimes were retained for inspection (paths in the drill logs).
The interactive console decisions were driven through the same
`/v1/approvals/:id/decision` operator surface the auto-decide smoke runs
exercise; the console rendered the inbox, evidence, and decision receipts.
