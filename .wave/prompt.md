# Worker brief — VUH-698 approval-ceremony rig

- **Mission:** Clankie v2 M2 close-out (run `2026-07-18-close-wave`)
- **Task / issue:** VUH-698 "Human merge approval through the minimal console" — build the live ceremony rig (the human decision itself is performed by the lead afterwards, NOT by you)
- **Role:** implementer
- **Worker-run id:** close-wave/vuh-698-rig
- **Worktree / branch:** this worktree, branch `claude/vuh-698-ceremony-0718` (base `c1f81d7`, preflight green: typecheck/test/arch:check all pass)

## Authoritative issue context (mirrored — you have no tracker access)

VUH-698 (M2, assignee James) acceptance criteria:
1. **Human step:** review a real approval request end-to-end and approve/reject it in the console (performed by the lead after your rig lands — out of your scope)
2. Approval identity, timestamp, and doctrine hash recorded in the audit log
3. Rejection path returns the task to the lead with the human's reason attached

Context: M2's exit requires a human approving the final simulated merge — human authority at the irreversible boundary. The approval request must surface in the minimal console (`@clankie/tui` `/approvals` inbox, `apps/tui/src/approval-inbox.ts`) with plan, evidence, and policy rationale; the privileged connector executes only after `allow` + approval.

## Objective

Build a reproducible **approval ceremony drill** that gets a real control plane to a *pending merge-approval request* so a human (the lead) can attach the console and decide. Concretely:

1. A script (suggested: `apps/lead-agent-lab/scripts/approval-ceremony.mjs`, root alias `drill:approval-ceremony` in `apps/lead-agent-lab/package.json` — do NOT touch the root `package.json`) that:
   - boots the real control plane on an ephemeral loopback port with an isolated event store (own tmp/XDG state; ports 4321, 8082, 4313 untouched);
   - drives the frozen scenario (or a minimal faithful mission) with sim workers up to the point where the final simulated **merge** is requested as a privileged action, producing a durable **pending approval request** with plan/evidence/policy rationale attached;
   - prints exact instructions + environment (URL, event-store path, operator credential bootstrap) for attaching the console (`clankie` / `pnpm --filter @clankie/tui dev`) to that control plane;
   - stays running (or is resumable) until the operator decides, then reports the decision outcome, and on rejection shows the task returned to the lead with the reason attached;
   - verifies and prints where identity, timestamp, and doctrine hash are recorded in the audit/event log (event names + fields), so the lead can cite them as evidence.
2. Support BOTH decision paths in one or two invocations: reject-with-reason first (assert the task returns to lead with reason), then approve (assert the privileged connector executes only after approval).
3. A short runbook at `docs/testing/2026-07-18-vuh-698-approval-ceremony/README.md` describing the drill, expected event sequence, and evidence fields.

Reuse existing machinery (lead-agent-lab lab/scenario plumbing, control-plane `/v1/approvals` + `/v1/approvals/:id/decision`, api-client `listApprovals`/`decideApproval`). Do not fork a second scheduler; the control plane remains authoritative.

## Write scope (hard)

- `apps/lead-agent-lab/**`
- `docs/testing/2026-07-18-vuh-698-approval-ceremony/**`
- this worktree's `.wave/**` (result + sentinel)

Read-only: everything else. Do NOT modify control-plane, tui, mission-engine, doctrine, evaluator, or any frozen acceptance test. If the rig is impossible without a small change outside scope, STOP and write `.wave/BLOCKED` naming the exact seam and smallest change needed.

## Success criteria

- `pnpm --filter @clankie/lead-agent-lab drill:approval-ceremony` (document exact invocation) reaches a pending approval, and a scripted smoke mode (`--auto-decide reject` / `--auto-decide approve`, using the same authenticated operator path the console uses) proves: rejection returns the task to the lead with reason; approval releases the privileged connector; audit log records identity, timestamp, doctrine hash.
- The interactive path (console attach) is documented and left available for the lead's live ceremony.
- Narrow checks first, then required gates: `pnpm typecheck`, `pnpm test` (at minimum the lead-agent-lab suite), `pnpm arch:check`. All green in this worktree with observed exit 0.

## Evidence & handoff

Write `.wave/result.md` with: summary, files_changed[], commands_run[] with exit codes, the exact drill invocation(s), the observed event/audit excerpts (redacted), remaining_risks[], assumptions[]. Commit on your branch (`claude/vuh-698-ceremony-0718`); do NOT merge or push. Then create `.wave/DONE` (or `.wave/BLOCKED` with the blocker in result.md).

## Budget & stop guards

Soft budget ~90 minutes of work. Stop and write BLOCKED rather than: weakening/skipping any existing test, widening write scope, or emulating the approval inside the mission engine without the real control-plane boundary.
