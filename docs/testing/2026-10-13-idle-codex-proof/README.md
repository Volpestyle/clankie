# VUH-2214: idle Codex catalog caller lifetime

Tracks: https://linear.app/vuhlp/issue/VUH-2214

## Cause

Read-only pane inspections confirmed the work lead's four seats were idle.
No input, close, restart, native refresh or receipt replay was sent to them.
The private service log attributed recent `/v1/fleet/mcp` refusals to short-lived
socket callers: ancestry failed at index zero with ESRCH and a new bridge ID.
These records identify the HTTP route, not the JSON-RPC method.

Code inspection explains the race. Codex catalog snapshots create temporary MCP
connection sets, collect tools and cancel those sets. Clankie's bridge returned
`tools/list` and then sent `notifications/clankie/bridge_status` without awaiting
it. A temporary snapshot could kill its bridge while the service was checking
that notification's socket owner. `local-fleet-proof.ts` then refused the absent
initial observation as `native_initial_unavailable`. An idle model turn is not
required: catalog discovery itself starts these clients.

The bridge now completes the existing bounded, advisory health notification
before returning the catalog. It still catches notification failure, retains the
two-second bound and rechecks the active-tool-call publication barrier. Native
proof, authorization, refusal metrics and alert thresholds are unchanged.

## Evidence

Live **before**, a settled 15-minute interval (2026-10-13 07:30–07:45 UTC):
89 refusals, all `native_initial_unavailable`, **5.93/minute**. Pane counts:
`p7=0`, `p9=54`, `pA=25`, `pB=10`. Current observations do not establish earlier
caller attribution. The sanitized capture is `.local/vuh-2214/live-before.json`
in the assignment worktree.

The owned scratch producer compares the committed baseline with the fixed
bridge. It uses real HTTP/stdio subprocesses and both initial/final observations
from the production compiled native socket/process/ancestry helper. A 100 ms
health-check gap deliberately exposes immediate snapshot shutdown. Baseline:
**12/12 health observations refused** after discovery let the caller exit.
The fixed producer holds four persistent idle bridges and repeats temporary
catalog probes for at least 15 minutes; raw results are retained under
`.local/vuh-2214/`. This isolates the caller-lifetime boundary, not a full native
Codex/Herdr or live-service after-deployment proof.

Focused checks: `clankie heavy -- pnpm exec vitest run
apps/clankie/test/hired-catalog-bridge.test.ts
apps/clankie/test/worker-bridge-concurrency.integration.test.ts` passed,
**2 files / 26 tests**. The new regression retains the HTTP health request and
proves that native discovery cannot return until it finishes, then immediately
closes the real bridge subprocess. Existing publication/concurrency checks pass.

The owner deploys. Post-deployment live refusal rates remain a separate check;
the original work lead's seats and unsettled receipts remain untouched.
