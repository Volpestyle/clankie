# VUH-2029: policy-aware service Auto staffing

Fixes the unconditional `turn.autonomous` hire refusal observed in the
[two-project window](../2026-10-12-vuh-2029-auto-window/README.md).
The authoritative blocker is builtin
`LOCAL-VUH-6` (`clankie-work://local/issue/24ef0c94-d2f4-4c8f-af63-595e5e2f0dcb`),
under `/Users/james/dev/tracker-research-20261008`.

The host carries its autonomous-turn flag to the ordinary captain hire port;
the model cannot select that flag. Original conversation authority and current
saved owner policy are checked together at native admission boundaries.
Master Auto must be on, global saved autonomy must be Full, and the resolved
project must be on Auto. Project preferences may still withhold hiring approval.
The existing cap, workspace/identity, machine, account and delivery fences remain.

## Regression and boundary proof

The live attempt was Iris, builder, project `clankie-work`, deliverable
LOCAL-VUH-4, source `conv-4c11af56-0e37-4870-9294-bf307fc3c0d0`, Full autonomy
and project Auto on. At 17:20:24.650Z, cursor 3628 recorded:

```text
Autonomous turns may propose a hire, not execute one
```

The regression uses the authored `hire_agent`, production `autoHireAuthority`,
real SettingsStore, production project HTTP routes, real ProjectHires ledger,
production resource admission, native process identity and PersonaStore adoption.
The existing executable native-protocol helper receives and acknowledges one
real first prompt. No provider, model or eval runs. Its disposable path and
OpenCode helper replace the live path and Codex harness; it does **not** prove
installed Codex TUI behavior, account credentials or a deployed Auto model turn.

Reinstating the exact old guard fails the positive acceptance assertion before
any native effect (exit 1):

```text
FAIL LOCAL-VUH-6: starts one Full Auto hire through native admission, then enforces the cap
Error: Autonomous turns may propose a hire, not execute one
Object.execute apps/clankie/src/captain/tools.ts:1064:43
```

Corrected-source results:

- Full + project Auto starts one helper hire; the second is refused by cap 1.
- High global autonomy, project Auto off and owner-gated project setup refuse
  before launch, with the reason retained.
- Cap 0 and low available memory retain the ordinary admission refusal.
- Lowering saved autonomy, disabling project/master Auto or revoking the route
  during preparation prevents the pending native launch.
- Existing owner hires, native routing and worker-account API checks remain green.

```text
clankie heavy -- pnpm exec vitest run \
  apps/clankie/test/captain-hire.test.ts \
  apps/clankie/test/fleet-resource-hire.integration.test.ts \
  apps/clankie/test/runtime-provider.integration.test.ts \
  apps/clankie/test/worker-accounts.integration.test.ts
Test Files 4 passed (4)
Tests 41 passed (41)
```

Focused source typechecking passed (445 roots), as did the first three existing
test programs. The affected fourth program initially found two fixture type
errors (HTTP server union and missing adopted persona); after correction its
exact retained compiler input passed. This is focused type evidence, not a
green full-repository gate. Explicit touched-file lint and formatting passed;
the integrator supplies the exact-tree root landing gate.

Private logs are retained in the task worktree's ignored `.local/`:
`vuh-2029-staffing-before-positive.log`, `vuh-2029-staffing-final-checks.log`,
`vuh-2029-staffing-typecheck.log`, `vuh-2029-staffing-typecheck-fixed.log`,
`vuh-2029-staffing-lint.log` and `vuh-2029-staffing-format.log`.

## Remaining product proof

The next deployed Auto round must show a real configured project selecting ready
work and starting an admitted native worker without an owner prompt, then retain
its delivery and work evidence. This pre-deploy integration proof does not meet
that full unattended staffing/landing acceptance. Deployment belongs to the lead.
The disconnected service-lead reply gap remains
[VUH-2174](https://linear.app/vuhlp/issue/VUH-2174).
