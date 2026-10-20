# VUH-2551: settings loads and seat efficiency

The two service profiles supplied by the lead identify repeated settings parsing
and whole-fleet efficiency signatures as recurring CPU costs. This change targets
only those two paths. It does not establish the reduction in live service CPU;
the lead will deploy and measure that separately. No live service was signalled,
restarted, attached to, or used as a benchmark target.

## Controlled before/after measurement

Node v26.12.0, macOS, three alternating baseline/fixed pairs in fresh processes.
Baseline: `ff8930b064f9d9c615993e32ddd2dd5641f30f02`. Each process performs 50,000
warm settings loads, then 50,000 observations across 100 retained seats. Settings
contain 30 synthetic machine connections; observations are stable and working.
CPU includes user and system time from `process.cpuUsage()`, including process
helper work. Load1 at sample completion ranged from about 2.99 to 3.15.

| Workload                       | Before median CPU ms | After median CPU ms | Reduction |
| ------------------------------ | -------------------: | ------------------: | --------: |
| 50,000 settings loads          |             1790.817 |             910.330 |     49.2% |
| 50,000 observations, 100 seats |             3272.854 |            1140.966 |     65.1% |

These are microbenchmarks, not a prediction of total service CPU or a reproduction
of service startup, native workers, or live multi-seat traffic. The benchmark
clock is fixed, so timestamp-only persistence behavior is separately tested with
an advancing clock. Raw pairs and the executable benchmark are in the evidence
manifest. To reproduce on the baseline and fixed revision, fetch `bench.mts` into
this directory and run `clankie heavy -- node
docs/testing/2026-10-20-vuh-2551-hot-paths/bench.mts` on each revision.

## Change and checks

`load()` checks device, inode, size, nanosecond mtime and ctime before reusing
validated data. It copies the cached JSON tree for callers. API writes invalidate
all settings views; external edits and errors still go through validation.
`loadFenced()` continues reading the actual descriptor and checking its generation.
`checkoutGit` itself launches Git directly; no change was made to that path.

Seat observations compare only that occupant's state, excluding `checkedAt`,
before sorting/signing the fleet. Signatures use direct JSON serialization
without a per-field replacer callback. Successful persistence alone refreshes
saved signatures, so failed writes retry. Full schema and owner validation remain.

Focused validation: 32 tests in four files passed, including API invalidation,
unchanged-file reuse, private-copy isolation, external edits with restored mtime,
replacement/corruption/deletion, descriptor fences, timestamp-only ticks,
time-driven semantic flags, restart continuity and retry after a failed save.
The required root landing gate is recorded in the issue result after committing.

Raw results, benchmark and focused check log are published through `evidence.json`.
