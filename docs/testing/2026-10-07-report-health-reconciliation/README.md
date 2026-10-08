# Worker report health and proof-reason reconciliation

Audited the two assigned prior worktrees against fetched `origin/main`
`60ef342706a9571eab9c3888ab51c059c5e5833b`. Both prior worktrees were clean.
No production delta remains to replay from either worktree.

## Commit disposition

| Prior worktree               | Commit                                     | `git cherry origin/main` | Disposition                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ash-vuh-1703-report-health` | `d50a1e749ebf21a2c3949ce0547b2e0c73341124` | `-`                      | On main by identical patch as `a3be8403`: real bridge binding timeout, three-seat alert, finished-unreported flags and stored-report recovery, with retained live observations.                                                                                  |
| `oren-proof-reason-coverage` | `1f74ab6ce605df63b27ba827cedce70879c0f265` | `-`                      | On main by identical patch as `f59d4bd4`: report health, fixed metrics and roster/doctor projections.                                                                                                                                                            |
| `oren-proof-reason-coverage` | `9da35c24df01922d8d557d6d4a78123708517968` | `-`                      | On main by identical patch: retain health alerts behind unresolved native receipts.                                                                                                                                                                              |
| `oren-proof-reason-coverage` | `a0021dfe680846f9a6277dc80694b62118728e78` | `+`                      | On main by content through `1419c9b0780932c97cd804334c426fb14eb1c0a9`, retained through `4018414250c9911bf4efc23fe1d650fed951880d`. Abandon a separate replay: the integration contains the delta alongside other edits, so whole-commit patch identity differs. |

For `a0021dfe`, compared all fourteen changed paths with `1419c9b0`.
Twelve are identical. The other two retain Oren's changes and additionally
cover peer authority (`project-native-proof.integration.test.ts`) and correct
the descriptor-churn acceptance explanation (`integrations/fleet-proof/README.md`).
Both integration commits are ancestors of the audited main.

Current main still contains the fixed `NativePaneNotFoundError`, project native
diagnostic forwarding, separate `closed_socket` refusals, and pure final-budget
expiration handling. It retains all thirteen terminal refusal scenarios,
the vocabulary/HTTP counter contract and exhaustion captures, invalid-pin and
absent-owner assertions, and project closed-socket/oversized-argv scenarios.
The exec-argv fixture and captured exhaustion JSON are unchanged from Oren's
commit. Later attribution and native-observer changes supersede the old source;
replaying it would risk undoing those fixes.

## Acceptance still open

Read VUH-1703, VUH-1704 and their complete comment threads, plus parent VUH-1701
and the Clankie project, through Clankie's connected Linear tools. Verified the
authenticated actor is the workspace Clankie OAuth app before status writes.

- VUH-1703: service/CLI/doctor and real bridge timeout/recovery proof are on
  main. The app roster remains held for James's World redesign according to
  the latest issue and parent comments. No app changes or deployed fleet
  threshold-alert receipt are claimed by this reconciliation.
- VUH-1704: terminal proof reasons, receipt reasons, five/sixty-minute metrics
  and integration alert routing are on main. The current
  [reason coverage](../../../integrations/fleet-proof/REASON-COVERAGE.md)
  retains the unproved real `allocation_failed` producer and distinguishes
  direct defensive-guard tests from OS producers. Live original-owner TUI alert
  acceptance remains open; the latest attribution evidence also retains the
  pane-less refusal policy question. This assignment does not change threshold
  policy, disrupt the OS to manufacture allocation failure, or steer the owner lane.

Neither issue meets its complete recorded acceptance, so neither is closed.
No old-worktree commit is left awaiting integration or a disposition.

## Verification

`clankie heavy -- pnpm install` passed in this worktree.

Fresh focused verification passed: four files, 23 tests, 25 seconds:

```sh
clankie heavy -- pnpm exec vitest run --config vitest.config.ts \
  apps/clankie/test/worker-bridge-health.integration.test.ts \
  apps/clankie/test/fleet-health-metrics.integration.test.ts \
  apps/clankie/test/fleet-report-reasons.integration.test.ts \
  apps/tui/test/worker-bridge-status.integration.test.ts
```

The focused result verifies the existing bridge timeout/recovery proof, fixed
receipt failures, metrics vocabulary/HTTP contract, and roster/doctor projections.
Local log: `.local/report-health/focused.log` in the reconciliation worktree.
Existing native evidence is retained; native opt-in suites and evals are not
implied by these checks or a landing gate. The final landing-gate result and
pushed commit are attached to each issue's evidence comment.
