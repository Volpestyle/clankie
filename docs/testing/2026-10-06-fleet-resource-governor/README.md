# VUH-1740: shared fleet resource governor

The branch ships `clankie heavy -- COMMAND`, owner resource settings, named-seat
simulator leases, local hire pressure checks, cached fleet/doctor resource status,
and a product skill included in ordinary and standalone worker packages.
Automatic capacity is **2** on the measured 18-core, 128 GiB Mac. Heavy commands
and simulator leases share the same OS-account registry across worktrees.

[Checks](checks.json) records the focused tests and build limits.
[Burst data](burst-summary.json) preserves measured values, actual command
receipts, process exit proofs, policy, budgets, source hashes and cleanup.
Raw local artifacts remain under `.local/verification/vuh1740` and the named
`.local/vuh1740-*.json` paths, with their hashes in the committed summaries.
The final candidate composes main `2e1c08be`, preserving runtime health, metrics,
Linear budget and game wiring. Recorded source hashes identify measured inputs
independently of the eventual evidence commit. Affected checks were rerun after
composition; unchanged native-process cases retain their valid preceding proof.

| Proof                                                 | Result                                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Ten real command processes, private two-slot registry | Max active **2**, max permits **2**, max queued **8**                                                                   |
| Service health p95, baseline / burst                  | **1.03 / 1.03 ms**, budget 250 ms                                                                                       |
| Service CPU mean, baseline / burst                    | **0.54 / 1.35%** of one core, budget 10%                                                                                |
| Owned job memory                                      | 16 MiB allocation, max observed RSS **31.80 MiB**                                                                       |
| Cleanup                                               | Ten exact process births exited, zero leases/queue, owned service and drivers exited                                    |
| Focused tests                                         | **131 pass**, zero failures; 14 files across coordinated runs                                                           |
| Typechecks                                            | Protocol, governor, settings, service and TUI pass; multi-package checks serialized                                     |
| Packaging                                             | Isolated bundled launcher help and native runner pass; child exit 17 preserved; both worker skills copied and validated |

The native review corrected uncertainty being treated as exit, unrelated census
failures blocking reconciliation, the runner counting its own process observer,
and nested submission after cancellation. Kernel process birth and group checks
retain surviving descendants. Actual CLI checks preserve child `--chat`, exit 41,
and Ctrl-C exit 130. HTTP tests use a real TCP listener and process-based device
adapter; they prove current owner checks after awaited proof/inventory, reject
caller-provided kernel identity, and return safe typed refusals. Missing native
helpers leave the runtime available and refuse new local builders. Helper availability
is independent of the captain PID, preserving hosted PID 1 admission without
authorizing PID 1 as a lease holder or signal target. That case uses a controlled
caller-PID fixture with the actual helper subprocess.

The simulator integration cases cover common capacity, external booted devices,
seat replacement, original process exit, idle cleanup, late authorization loss,
unknown create receipts and observer shutdown. Native device effects use a real
subprocess fixture, **not CoreSimulator**. No live `xcrun` or simulator boot was
authorized or run. James must authorize a one-device live smoke before claiming
that native boundary is verified. Only created exact UUIDs may be touched.

The burst reuses VUH-1706's real Captain/service embedding and isolated Herdr
server. It adds ten governed command processes without hiring agents. The fixture
owner deliberately sets load/core 16 and minimum memory 0 to isolate admission
and queueing; default pressure refusal is tested separately with controlled
sensors. This uses the Captain/service embedding rather than full index startup.
Discord, models and other body providers are absent. CPU is the service
process and excludes helper/command CPU. This complements the existing release
worker-bridge gate; it does not replace it.

This original run took **67.1 seconds** for ten two-second jobs, with the first
command at 13.9 seconds. The
[admission follow-up](../2026-10-06-resource-admission-latency/README.md) profiles
and fixes that delay, records a 15.9-second rerun and introduces budgets for this
fixed fixture. Linux failure branches have captured fixtures but no live Linux
kernel/container proof; the Docker daemon was unavailable. The
[exact container procedure](linux-validation.md) records the remaining validation.
Python 3 is an explicit self-hosted dependency and is installed by the hosted image.
Existing harness/plugin caches were not refreshed; standalone packages must be
updated as complete artifacts, including the companion skill and receipt.

Manual invocation, through the active fleet limiter:

```sh
clankie heavy -- pnpm check:resources -- --run
```

The script requires `--run` and is absent from `pnpm check`, push/PR workflows and
scheduled CI. Full repository gates and release builds remain with the integrator.
No AWS deployment or `clankie-app` changes were made.
