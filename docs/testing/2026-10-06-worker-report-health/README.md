# VUH-1703: worker report health acceptance

The CLI/TUI/doctor implementation already exists on main `7e26bfa9`.
This branch adds one combined integration case and retains fresh, read-only live
evidence. It changes no runtime behavior or installed worker/session.

## Acceptance boundary

| Requirement                                                                  | Evidence and result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Outcome, time and safe reason in the roster/doctor                           | `clankie herdr agent list` and `clankie doctor --json` independently show stored reports and the finished-unreported flag. [Sanitized live captures](live-observations.json). The TUI roster and `/doctor` project the same `workerReportBridge` fields; existing HTTP/schema/rendering tests pass.                                                                                                                                                                                                                |
| Done/idle for fifteen minutes without a stored report since the latest brief | Production `SeatEfficiencyStore` tests cover the boundary, a newer brief, inactivity reset and stored recovery. The live CLI and doctor both show one flagged seat.                                                                                                                                                                                                                                                                                                                                                |
| Three recent failing seats trigger one alert to their owning lead            | Existing Captain/native-outbox integration verifies the ten-minute window, unowned-seat exclusion, exact owning conversation, one incident, recovery and rearming. The new combined case takes actual bridge failure observations through the production alert state machine and exact recipient ACK.                                                                                                                                                                                                              |
| Real bridge timeout produces the flag/alert and recovery clears it           | The new case starts three actual `seat-channel.mjs` subprocesses and production `WorkerMcp` HTTP endpoints. Delayed binding reads exceed their bounded deadline; each returns uncertain with safe reason `binding_timeout`, retains a ready tool catalog, and performs zero message POSTs. Inactivity evidence produces `finished, unreported`. Two failures do not alert; three produce one owning-lead event. Fresh stored reports from those same bridges clear all three flags and produce one recovery event. |
| Separate app roster                                                          | Still held. The latest issue comments explicitly preserve James's app redesign hold. App main does not contain `workerReportBridge`; the prior app candidate `afe9d8b` is not an ancestor. No app files or another worker's redesign edits were changed.                                                                                                                                                                                                                                                           |

The core CLI/TUI/doctor slice of [VUH-1703](https://linear.app/vuhlp/issue/VUH-1703)
is met. James directed this slice to finish while preserving the app hold; the
lead will split the remaining app roster acceptance into James's World redesign.
No deployed threshold-alert receipt is claimed.

## Verification scope

The original five focused files passed 65 checks before editing. The new combined
case passed separately. The final focused run passed **66 checks in five files**:

- `apps/clankie/test/worker-bridge-health.integration.test.ts`
- `apps/clankie/test/fleet-lead-round.integration.test.ts`
- `apps/clankie/test/seat-efficiency.integration.test.ts`
- `apps/tui/test/worker-bridge-status.integration.test.ts`
- `apps/tui/test/live-agents.test.ts`

After the final fixture identity and owner labels were aligned, the changed
bridge file passed all **9 checks** again. The service typecheck
(`pnpm --filter @clankie/clankie typecheck`), lint of the changed test, formatting
of the three changed files and `git diff --check` also passed.

The owned test uses real subprocesses, HTTP/MCP transport, disk settings and
receipt retention, `SeatEfficiencyStore`, `FleetReportFailureAlerts` and
`SeatOutbox`. The inactivity clock is advanced locally; this is a component
integration rather than a physical fleet or app acceptance run. Each worker
fixture has its own owned listener, settings, receipt state and bridge process.
The alert is ACKed only by the original owning binding. Recovery sends separately
new intent after binding-read failure, which had posted no report; it does not
retry a dispatched uncertain original.

All installs and checks use the backlog heavy wrapper and `clankie heavy`.
Raw receipts are ignored under `.local/evidence/vuh-1703/`. No full check,
simulator, eval, live report send, live fault injection or live restart ran.
The installed CLI's `herdr agent list` does not accept `--json`; its ordinary
invocation already emits the enriched JSON. Missing health remains unknown.

The worker's native report bridge remains unavailable. This evidence is handed
to the lead through the pane/final summary as requested; no alternate sender or
account connector was used. Connected ticket reads used the service-owned,
read-only `clankie linear read` route.
