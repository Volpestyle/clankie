# M1 control-plane and TUI crash recovery

| Field       | Value                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| Date        | 2026-07-11 (America/Chicago)                                                                                |
| Issue       | VUH-693                                                                                                     |
| Code scope  | M1 drill; TUI recovery probe; existing control-plane, runner, API client, and SQLite event-store boundaries |
| Verified on | macOS 27.0, arm64; local live processes and a temporary SQLite database                                     |
| Driver      | Node 26.3.1, pnpm 11.11.0, tsx 4.23.0                                                                       |

## What was wrong

1. The M1 components had focused recovery tests, but no integrated drill killed the real control-plane process and TUI while three leased worker processes continued running.
2. Mission-record replay, worker leases, terminal sequence replay, and connector side-effect idempotency were proven in separate tests. Nothing asserted their combined state before and after the same crash window.
3. The first driver attempt supplied a repository-relative doctrine path to `pnpm --filter @sapling/control-plane start`. pnpm starts that command in the package directory, so the child looked under `apps/control-plane/doctrine/` and never reached health.

## What was built

| Piece              | File                                                                        | Substance                                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drill driver       | [`scripts/m1-exit-gate.ts`](../../../scripts/m1-exit-gate.ts)               | Starts and leases three child workers, exposes semantic terminal replay, SIGKILLs the control plane and TUI, reconnects, and asserts exact recovery.                       |
| TUI recovery probe | [`apps/tui/src/recovery-probe.ts`](../../../apps/tui/src/recovery-probe.ts) | A non-interactive mode of the real TUI entrypoint that reads mission state, consumes terminal replay, atomically checkpoints cursors/bytes, and stays alive for the crash. |
| Re-run flow        | [`flows/run-local.sh`](flows/run-local.sh)                                  | Runs the same driver from any checkout location and forwards optional driver arguments.                                                                                    |
| Evidence bundle    | [`evidence/`](evidence/)                                                    | Machine-readable report, hash-chained event log, before/after TUI checkpoints, and scrubbed control-plane logs.                                                            |

## Verification methodology

```mermaid
flowchart LR
  G[Focused gates] --> E[Start real control plane]
  E --> W[Lease 3 live workers]
  W --> C[TUI consumes mission + terminal replay]
  C --> K[SIGKILL control plane + TUI]
  K --> R[Restart TUI from saved cursors]
  R --> A[Assert exact records, replay, and idempotency]
  A --> P[Write curated evidence]
```

The runner stays alive because that is the M1 trust boundary under test. The driver uses the real `@sapling/control-plane` start command, `SqliteEventStore`, `ProcessLeaseManager`, and `TerminalManager`. It launches `apps/tui/src/index.ts --recovery-probe`, so the process receiving SIGKILL is the real `@sapling/tui` entrypoint. The recovery mode uses `SaplingApiClient` for mission state and requests sequenced terminal frames from the runner boundary; the driver validates the TUI's persisted cursors and reconstructed bytes rather than consuming replay on its behalf.

The successful campaign command was:

```bash
pnpm exec tsx scripts/m1-exit-gate.ts \
  --output docs/testing/2026-07-11-m1-crash-recovery/evidence
```

## Debug log

1. **Startup dead end:** the first run timed out waiting for control-plane health. A direct reproduction showed `ENOENT` for `apps/control-plane/doctrine/profiles/rawdog.yaml`. The driver now passes an absolute doctrine path and includes captured child logs in readiness failures.
2. **Surrogate-console failure:** the first independent verification rejected a headless API poller because the frozen gate explicitly says to crash the TUI, and that poller never consumed terminal replay. The drill now invokes the actual TUI entrypoint in recovery mode. The TUI writes the initial cursor/byte checkpoint, receives SIGKILL, then restarts from that checkpoint and consumes every resumed frame itself.
3. **Complete pass:** three workers remain alive under unchanged leases while the control plane and TUI receive SIGKILL. Every recovered TUI cursor starts at the preceding cursor plus one and reconstructs the deterministic worker byte stream exactly.
4. **Idempotency replay:** the same side-effect operation runs twice through the drill boundary. The exclusive side-effect ledger executes it once, and re-appending the identical event returns sequence 12 without adding a second event.
5. **Repeatability check:** a second run in a fresh temporary state root produces the same semantic result: 12 valid events, three live exact leases, three gap-free byte-exact TUI replays, and one side-effect occurrence.
6. **Cleanup check:** unrelated shared-worktree changes do not participate. The driver creates its database, lease files, side-effect ledger, and ports under a fresh temporary state root, kills every child it owns, and removes that root after assertions. It records only the explicit output directory.

## Evidence index

| File                                                                  | What it proves                                                                                                                                                       |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`01-drill-report.json`](evidence/01-drill-report.json)               | All assertions passed; three workers stayed live; mission, projection, event log, leases, terminal replay, and side-effect counts match the contract.                |
| [`02-events.jsonl`](evidence/02-events.jsonl)                         | The 12-entry SHA-256 chain contains one mission draft, one plan, three lease registrations, three leased/running task pairs, and exactly one side-effect completion. |
| [`03-console-before.json`](evidence/03-console-before.json)           | Pre-crash TUI checkpoint containing the mission record, three terminal byte streams, and their sequence cursors.                                                     |
| [`04-console-after.json`](evidence/04-console-after.json)             | Reconnected TUI checkpoint; mission equality, contiguous resumed cursors, prefix preservation, and deterministic full streams are asserted by the driver.            |
| [`05-control-plane-before.log`](evidence/05-control-plane-before.log) | Initial process opened an empty store, became ready, and durably recorded the mission and three-task plan.                                                           |
| [`06-control-plane-after.log`](evidence/06-control-plane-after.log)   | Restarted process rebuilt exactly one mission from the same store and became ready on the same endpoint.                                                             |

## Re-run instructions

From the repository root:

```bash
bash docs/testing/2026-07-11-m1-crash-recovery/flows/run-local.sh
```

The flow requires the installed pnpm workspace, Node 24 or newer, local loopback ports, and macOS process identity support used by `ProcessLeaseManager`. It creates temporary process/database state, removes that state after the run, and writes generated artifacts to `artifacts/evals/m1-exit-gate/` unless `--output` is supplied. The control plane and TUI are deliberately killed with SIGKILL; the runner/driver process and three workers deliberately remain alive until assertions finish.

## Outcome

The M1 exit-gate drill passes. Recovered HTTP mission records, event-derived mission projection, the hash-chained event log, and all process leases are exact. The restarted TUI consumes sequence-contiguous terminal replay and reconstructs each byte stream exactly. Two attempts at one external side effect produce one ledger entry and one event occurrence.

The drill uses real local worker processes rather than live provider adapters; provider protocol behavior is covered by the native adapter contract suite. The recovery probe is deliberately non-interactive so CI can drive the exact TUI crash/reconnect contract deterministically. VUH-700 still owns the operator-facing live mission dashboard; it does not own this recovery proof.
