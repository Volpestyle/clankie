# VUH-698 approval-ceremony rig — implementer result

worker-run id: close-wave/vuh-698-rig · branch `claude/vuh-698-ceremony-0718` (base `c1f81d7`)

## summary

Built the reproducible approval-ceremony drill. `drill:approval-ceremony` boots the
real control plane and the real pull runner (sim workers) on ephemeral loopback
ports with fully isolated tmp state (own event/memory store, credential file,
fixture repo, worktrees; ports 4310/4313/4321/8082 untouched), drives a minimal
faithful 2-task mission (sim implementer → independent sim verifier, trusted
check passing) to `mission.succeeded`, then — as lead — requests the simulated
`github.pr.merge` via `POST /v1/actions/decide`, producing a durable pending
approval (plan/evidence/policy rationale attached) in the operator inbox.

Both decision paths are proven through the same authenticated operator surface
the console uses (`/v1/approvals`, `/v1/approvals/:id/decision`):

- **reject:** approval record becomes `denied` with the operator's reason; the
  lead's re-request returns `effect=deny`,
  `matchedPolicyIds=["operator-approval:denied"]`, reason = "The authenticated
  operator denied this request: <human reason>" — the task returns to the lead
  with the reason attached; no connector executes.
- **approve:** before the decision a re-request still returns
  `require_approval` (connector boundary holds); after the recorded approval the
  policy engine re-evaluates with `humanApprovals=1` and returns `effect=allow`
  (`matchedPolicyIds=["human-approved-merge"]`), releasing the simulated
  connector only then.

The interactive mode reaches the pending approval, prints the exact console
attach environment (URL, operator token, event-store path,
`pnpm --filter @clankie/tui dev` → `/approvals`), stays running until the
operator decides, then reports the outcome and prints the verified audit
excerpt. Validated live: decided from a second terminal via the operator HTTP
path while the drill waited; it resumed and exited 0.

The control plane loads a doctrine profile derived at runtime from the frozen
`self-build-lab.yaml` (read-only) plus one explicit `github.pr.merge` release
rule (`allow` when `minHumanApprovals >= 1 && checksPassed`), mirroring the
canonical rule in `apps/control-plane/test/approvals.test.ts` — without it no
policy decision ever releases the connector after approval. Nothing under
`doctrine/` is modified.

## files_changed

- `apps/lead-agent-lab/scripts/approval-ceremony.mjs` (new — the drill)
- `apps/lead-agent-lab/package.json` (new script alias `drill:approval-ceremony`; root `package.json` untouched)
- `docs/testing/2026-07-18-vuh-698-approval-ceremony/README.md` (new runbook: drill, expected event sequence, evidence fields)
- `.wave/result.md`, `.wave/DONE` (this handoff)

## commands_run / checks

| command | exit | result |
| --- | --- | --- |
| `pnpm --filter @clankie/lead-agent-lab drill:approval-ceremony -- --auto-decide reject` | 0 | rejection path: pending → denied with reason → deny returned to lead; audit excerpt verified |
| `pnpm --filter @clankie/lead-agent-lab drill:approval-ceremony -- --auto-decide approve` | 0 | approval path: boundary holds pre-decision → approved → `allow` releases connector; audit excerpt verified |
| `pnpm --filter @clankie/lead-agent-lab drill:approval-ceremony` (interactive) + live operator decision from a second terminal | 0 | stays pending until decision; resumed and reported `approved` |
| `pnpm --filter @clankie/lead-agent-lab test` | 0 | 6 files, 44 tests passed |
| `pnpm typecheck` | 0 | 40/40 workspaces |
| `pnpm test` | 0 | 154 files passed, 2 skipped; 1344 tests passed, 3 skipped |
| `pnpm arch:check` | 0 | 40 workspaces passed |

`pnpm eval:self-build` skipped: no change touches the lab scenario/evaluator
surface it gates (drill is additive tooling; full `pnpm test` covers the lab
suite).

## observed audit evidence (redacted excerpt, reject run)

```text
approval.requested (sequence 26, chain verified)
  occurredAt: 2026-07-18T18:35:54.350Z   missionId: mission-ed0c8ede-eff
  correlationId: mission-ed0c8ede-eff    profileHash: 56c8aad9d3445cb6
  approval.status: pending

approval.decided (sequence 27, chain verified)
  occurredAt: 2026-07-18T18:35:54.359Z   profileHash: 56c8aad9d3445cb6   <- doctrine hash
  decidedBy: local-operator              <- approval identity
  decidedAt: 2026-07-18T18:35:54.359Z    <- decision timestamp
  reason: "Rejecting the simulated merge: the evidence bundle needs another verification pass."

lead re-request → effect=deny matchedPolicyIds=["operator-approval:denied"]
  reason="The authenticated operator denied this request: Rejecting the simulated merge: …"
```

Approve run: `approval.decided` with `status: approved`, same identity/
timestamp/doctrine-hash fields; re-request →
`effect=allow matchedPolicyIds=["human-approved-merge"]`.

## remaining_risks

- **Pre-existing, out of scope:** `pnpm --filter @clankie/runner start` fails on
  current Node before any runner code runs — `@xterm/headless` /
  `@xterm/addon-serialize` publish CJS mains without `exports` maps, so ESM
  named imports fail (`does not provide an export named 'Terminal'`). The drill
  starts the unmodified runner via the workspace `tsx` binary with a scoped
  `NODE_OPTIONS --import` resolver hook redirecting exactly those two bare
  specifiers to their shipped `.mjs` builds. This also affects
  `eval:real-workers` on this machine; deserves its own ticket (likely pnpm
  `patchedDependencies` adding `exports` maps, or import-site changes in the
  runner). The hook is a documented workaround, not a root-cause fix.
- The live ceremony records `decidedBy` as the control plane's
  `CLANKIE_OPERATOR_ID` (default `local-operator`); export it before the drill
  if the ceremony should carry a personal operator identity.
- The drill's "privileged connector" is simulated (a logged release after
  `allow`), matching the issue's simulated-merge scope; no real GitHub connector
  exists yet to wire in.

## assumptions

- "Frozen scenario or minimal faithful mission" — used the minimal 2-task
  implementation+verification slice (the exact shape the control-plane pull-plan
  gate admits), since the ceremony boundary, not the defect-recovery cycle, is
  under test.
- Deriving the drill doctrine profile at runtime from the frozen profile (plus
  the canonical release rule, under `CLANKIE_DOCTRINE` in the drill's tmp dir)
  is within scope: `doctrine/**` is untouched and the control plane remains the
  sole policy authority.
- Human acceptance criterion 1 (the lead's live console decision) is
  intentionally left to the lead; the interactive mode is the rig for it.
