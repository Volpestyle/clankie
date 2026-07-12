# M1 control-plane, runner, and TUI crash recovery

| Field       | Value                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Date        | 2026-07-11 (America/Chicago)                                                                     |
| Issue       | VUH-693                                                                                          |
| Code scope  | M1 drill; runner/TUI recovery probes; control-plane, terminal, lease, API, and SQLite boundaries |
| Verified on | macOS 27.0, arm64; local live processes and a temporary SQLite database                          |
| Driver      | Node 26.3.1, pnpm 11.11.0, tsx 4.23.0                                                            |

## What was wrong

1. The M1 components had focused recovery tests, but no integrated drill killed the real control-plane process, runner, and TUI while three leased worker processes continued running.
2. Mission-record replay, worker leases, terminal sequence replay, and connector side-effect idempotency were proven in separate tests. Nothing asserted their combined state before and after the same crash window.
3. The first driver attempt supplied a repository-relative doctrine path to `pnpm --filter @clankie/control-plane start`. pnpm starts that command in the package directory, so the child looked under `apps/control-plane/doctrine/` and never reached health.
4. The first completed archive kept the runner/driver alive. That satisfied the frozen Linear/build-plan wording (“control plane + console”) but not the operator objective’s stricter “control plane + runner” wording. A completion audit reopened VUH-693 rather than silently treating those contracts as equivalent.

## What was built

| Piece                 | File                                                                              | Substance                                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drill driver          | [`scripts/m1-exit-gate.ts`](../../../scripts/m1-exit-gate.ts)                     | Starts the real control plane, runner, and TUI; crashes all three; verifies worker survival, re-adoption, replay, mission recovery, idempotency, and cleanup.                       |
| Runner recovery probe | [`apps/runner/src/recovery-probe.ts`](../../../apps/runner/src/recovery-probe.ts) | A non-interactive mode of the real runner entrypoint that owns detached workers, durable pid/start-time leases, stable terminal IDs, log-backed replay, and restart reconciliation. |
| TUI recovery probe    | [`apps/tui/src/recovery-probe.ts`](../../../apps/tui/src/recovery-probe.ts)       | A non-interactive mode of the real TUI entrypoint that reads mission state, consumes terminal replay, atomically checkpoints cursors/bytes, and stays alive for the crash.          |
| Re-run flow           | [`flows/run-local.sh`](flows/run-local.sh)                                        | Runs the same driver from any checkout location and forwards optional driver arguments.                                                                                             |
| Evidence bundle       | [`evidence/`](evidence/)                                                          | Machine-readable report and event log, before/after runner and TUI checkpoints, and scrubbed process logs.                                                                          |

## Verification methodology

```mermaid
flowchart LR
  G[Focused gates] --> E[Start control plane + runner]
  E --> W[Runner leases 3 detached workers]
  W --> C[TUI consumes mission + terminal replay]
  C --> K[SIGKILL control plane + runner + TUI]
  K --> L[3 workers continue writing durable logs]
  L --> R[Restart runner + TUI]
  R --> A[Re-adopt leases + resume stable terminal cursors]
  A --> I[Assert exact state + one side effect]
  I --> P[Write curated evidence]
```

The driver launches the real `@clankie/control-plane`, `apps/runner/src/index.ts --recovery-probe`, and `apps/tui/src/index.ts --recovery-probe` entrypoints. The runner owns the three worker processes and `ProcessLeaseManager`; each worker is detached into its own process group and writes an append-only runner log, so killing the runner cannot kill or lose the stream. On restart, the runner re-adopts the same pid/start-time identities, restores each stable terminal ID, and rebuilds `TerminalManager` frames with the same line boundaries. The TUI—not the driver—requests replay from its saved cursors and persists reconstructed bytes.

The event log keeps its 12-event pre-crash prefix exactly. Runner recovery appends one `worker.readopted` event per worker, so the recovered mission projection has the same operational state with an audited event-count increase from 12 to 15. Suppressing those recovery events would make the log less truthful, not more exact.

The successful campaign command was:

```bash
pnpm exec tsx scripts/m1-exit-gate.ts \
  --output docs/testing/2026-07-11-m1-crash-recovery/evidence
```

## Debug log

1. **Startup dead end:** the first run timed out waiting for control-plane health. A direct reproduction showed `ENOENT` for `apps/control-plane/doctrine/profiles/rawdog.yaml`. The driver now passes an absolute doctrine path and includes captured child logs in readiness failures.
2. **Surrogate-console failure:** the first independent verification rejected a headless API poller because the frozen gate explicitly says to crash the TUI, and that poller never consumed terminal replay. The drill now invokes the actual TUI entrypoint in recovery mode. The TUI writes the initial cursor/byte checkpoint, receives SIGKILL, then restarts from that checkpoint and consumes every resumed frame itself.
3. **Completion-audit failure:** the first passing archive killed the control plane and TUI while its in-process runner stayed alive. The attached operator objective explicitly required a runner crash. VUH-693 was reopened and the runner boundary moved into its actual entrypoint.
4. **Cleanup-harness dead end:** the first standalone runner probe used a zsh scalar as a PID list, then a retry used macOS Bash 3’s missing `mapfile`. Exact PIDs were recovered from the process table and killed; the unchanged probe then passed under a Bash-3-compatible array loop. The product driver does not depend on shell PID parsing.
5. **Projection mismatch:** the first combined drill expected the entire event-derived projection to be byte-identical. Re-adopting three workers correctly added three audit events, changing only `eventCount`. The assertion now freezes the 12-event prefix, requires exactly three unique `worker.readopted` events, and compares operational projection fields exactly.
6. **Complete pass:** the same three workers remain alive while the control plane, runner, and TUI receive SIGKILL. The new runner owns all recovered leases; every TUI cursor resumes at the preceding cursor plus one and reconstructs the deterministic worker stream exactly.
7. **Idempotency replay:** the same side-effect operation runs twice through the drill boundary. The exclusive side-effect ledger executes it once, and re-appending the identical event returns sequence 12 without adding a second event.
8. **Repeatability and cleanup:** fresh runs produce the same semantic result: 15 valid events, three exact re-adopted lease identities, three gap-free byte-exact TUI replays, and one side-effect occurrence. Every owned process and temporary state root is removed.

## Evidence index

| File                                                                  | What it proves                                                                                                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`01-drill-report.json`](evidence/01-drill-report.json)               | All three trusted processes received SIGKILL; three workers survived; runner re-adoption, mission state, leases, replay, and side-effect assertions passed. |
| [`02-events.jsonl`](evidence/02-events.jsonl)                         | The valid 15-entry SHA-256 chain preserves the 12-event prefix, adds three unique re-adoption events, and contains exactly one side-effect completion.      |
| [`03-console-before.json`](evidence/03-console-before.json)           | Pre-crash TUI checkpoint containing the mission record, three terminal byte streams, and their sequence cursors.                                            |
| [`04-console-after.json`](evidence/04-console-after.json)             | Reconnected TUI checkpoint; mission equality, contiguous resumed cursors, prefix preservation, and deterministic full streams are asserted by the driver.   |
| [`05-control-plane-before.log`](evidence/05-control-plane-before.log) | Initial process opened an empty store, became ready, and durably recorded the mission and three-task plan.                                                  |
| [`06-control-plane-after.log`](evidence/06-control-plane-after.log)   | Restarted process rebuilt exactly one mission from the same store and became ready on the same endpoint.                                                    |
| [`07-runner-before.json`](evidence/07-runner-before.json)             | Initial runner identity, stable worker/terminal mapping, pid/start-time leases, and empty reconciliation report.                                            |
| [`08-runner-after.json`](evidence/08-runner-after.json)               | New runner identity with the same three workers/leases, new lease ownership, and exactly three successful re-adoptions.                                     |
| [`09-runner-before.log`](evidence/09-runner-before.log)               | Initial runner restored three stable terminal IDs and reached its recovery checkpoint.                                                                      |
| [`10-runner-after.log`](evidence/10-runner-after.log)                 | Restarted runner reported three re-adoptions, no failures, and restored the same terminal IDs.                                                              |

## Re-run instructions

From the repository root:

```bash
bash docs/testing/2026-07-11-m1-crash-recovery/flows/run-local.sh
```

The flow requires the installed pnpm workspace, Node 24 or newer, local loopback ports, and macOS process identity support used by `ProcessLeaseManager`. It creates temporary process/database state, removes that state after the run, and writes generated artifacts to `artifacts/evals/m1-exit-gate/` unless `--output` is supplied. The control plane, runner, and TUI are deliberately killed with SIGKILL; the three detached workers deliberately remain alive through recovery and are killed only during final cleanup.

## Outcome

The M1 exit-gate drill passes the frozen control-plane/TUI contract and the stricter operator-requested runner crash. Recovered HTTP mission records and operational projection fields are exact. The event log has an unchanged pre-crash prefix plus one audited re-adoption per worker. Lease IDs, worker IDs, task IDs, pids, start times, heartbeats, expiries, and states are exact; only the owning runner PID changes to the new process. The restarted TUI consumes sequence-contiguous replay under stable terminal IDs and reconstructs every byte stream exactly. Two attempts at one external side effect produce one ledger entry and one event occurrence.

The drill uses real local worker processes rather than live provider adapters; provider protocol behavior is covered by the native adapter contract suite. The recovery probe is deliberately non-interactive so CI can drive the exact TUI crash/reconnect contract deterministically. VUH-700 still owns the operator-facing live mission dashboard; it does not own this recovery proof.
