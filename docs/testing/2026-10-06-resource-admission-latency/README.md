# VUH-1740: resource admission latency

The governor's ten-command burst now completes in **15.9 seconds**, down from
the reproduced **67.7 seconds**. The final run without profiling hooks admitted
its first command in **2.0 seconds**, held at most two permits, and passed the
service CPU, health and cleanup checks. [Measured data](comparison.json) and
[focused checks](checks.json) identify the exact source inputs and raw local
artifact hashes. This follow-up builds on governor handoff `6cd5c146`.

The original 67.1-second finding was the completion time of ten two-second heavy
commands through a private two-slot registry. It was not a measurement of native
agent hire startup. The same fixture reproduced that delay while profiling.

One protected same-user process made the broad host census fail. Reconciliation
then fell back to separate Python identity helpers for each queued owner and
running command while holding the shared OS lock. Ten contenders and the roster
observer repeated that work: **124 failed censuses and 855 individual identity
probes**. A separate read-only census reproduced the denied identity read. The
profile recorded helper operation, PID, parent PID, timings and exit status;
it did not record command arguments, environment values or helper output.

Reconciliation now collects the exact journal PIDs inside the held lock and
observes them in one bounded helper call. The helper reports live, exited or
unknown separately for each PID. Missing rows and failed or malformed replies
remain unknown. Exact process birth comparisons, runner registration under the
same lock, and surviving process group checks retain their authority. No cached
census supplies absence evidence. Wait callbacks use the advisory state from
the same admission attempt, projected after the transaction commits, avoiding
another lock acquisition just to publish status.

| Measurement                          | Before, traced | After, traced | Final, untraced |
| ------------------------------------ | -------------- | ------------- | --------------- |
| Ten-command completion               | 67.694 s       | 15.853 s      | 15.917 s        |
| First command in an empty pool       | 14.234 s       | 2.065 s       | 2.006 s         |
| Last command start                   | 65.564 s       | 13.717 s      | 13.717 s        |
| Maximum active / used / queued       | 2 / 2 / 8      | 2 / 2 / 8     | 2 / 2 / 8       |
| Service health p95 during burst      | 1.103 ms       | 1.082 ms      | 0.994 ms        |
| Service CPU mean during burst        | 1.843%         | 0.620%        | 1.650%          |
| Individual identity helper calls     | 855            | 30            | Not traced      |
| Broad census calls / failed          | 124 / 124      | 0 / 0         | Not traced      |
| Fresh targeted observation calls     | 0              | 133           | Not traced      |
| Accumulated time holding the OS lock | 65.496 s       | 9.785 s       | Not traced      |
| Mean lock-held interval              | 511.7 ms       | 70.9 ms       | Not traced      |

The paired traced runs use the same instrumentation and fixed workload. The
untraced run confirms the result independently of the profiling hook. Lock-held
intervals run from the helper's acquisition receipt to its completion. Summed
helper durations include overlapping waits and are not elapsed wall time.

The manual fixture now fails above **30 seconds total** or **5 seconds to first
admission in its empty pool**. These budgets apply only to its fixed ten
two-second jobs with two slots. Production commands may wait legitimately for
occupied permits. Service budgets remain health p95 250 ms and CPU mean 10% of
one core. The fixture explicitly sets load/core 16 and minimum memory 0 to
isolate admission; it does not validate default host pressure thresholds. CPU
measures the Captain/service process and excludes command/helper CPU. No real
native agent hire, model/provider traffic, full index startup or CoreSimulator
was exercised.

All three runs prove the ten exact command births exited, the registry has zero
leases and queue entries, and the owned runtime/driver processes and private
directories were removed. The focused checks pass **63 tests in six files**,
covering real process FIFO, owner/runner death, surviving groups, cancellation,
PID reuse, fresh targeted observations, denied reads, malformed replies and
consumer HTTP/CLI boundaries. Package, service and TUI typechecks pass. The
isolated bundled launcher/helper smoke preserves child exit 17 and leaves an
empty registry. All installs, tests, typechecks and owned runtime lifetimes
used the existing fleet heavy limiter; package typechecks were serialized.
No full repository check or release build was run.

Linux container validation remains unrun: `docker info` could not connect to
the local daemon, and the read-only Docker Desktop status query returned that
Desktop was not running. No daemon was started. The
[exact Linux procedure](../2026-10-06-fleet-resource-governor/linux-validation.md)
uses a committed archive, a fresh bounded container entirely within the heavy
limiter, focused native tests and an actual non-root Node PID 1 smoke. It records
source/image identities and keeps failure artifacts before exact-container
cleanup. A live CoreSimulator smoke remains subject to James's approval from
the preceding governor handoff.

Repeat the fixed burst from the candidate worktree:

```sh
/Users/james/.herdr-handoffs/clankie-backlog-20261003/bin/heavy \
  pnpm check:resources -- --run --output .local/resource-admission-repeat.json
```

The gate remains manual-only and is absent from push/PR, scheduled CI and
`pnpm check`. Raw profiles and reports are local under `.local/admission-profile`
and `.local/vuh1740-admission-native-tests.json`; the committed summaries retain
their SHA-256 receipts.
