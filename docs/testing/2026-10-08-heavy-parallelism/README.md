# Heavy parallelism (VUH-1876)

[Issue](https://linear.app/vuhlp/issue/VUH-1876).

The governor passes `VITEST_MAX_WORKERS=4` and `TURBO_CONCURRENCY=4` through
both native runner and verified nested-command paths. Lower positive integer
environment limits remain lower. This repository passes both variables through
Turbo's strict task environment. Vitest 4.1.10 reads its environment after
resolving config and CLI options; Turbo's environment is a default that explicit
CLI concurrency or `--parallel` can override. These are tool limits, not a CPU
quota for arbitrary commands. Nested Turbo tasks can still multiply task and
worker concurrency; compilers remain serialized per the fleet skill.

The real-process integration test executes a nested heavy command with absent,
higher and lower limits and observes the resulting child environment. The
heavy-process suite plus `lead-historical.test.ts` passed: 2 files, 31 tests,
82.32 seconds total, including VUH-1866's exact historical verifier case.
Fleet-resources typecheck passed. Dependencies were installed in this worktree
under the shared heavy governor, with no shared dependency symlinks.
An additional [real-tool check](tool-limit-proof.json) resolved Vitest's worker
count to four even with `maxWorkers: 99`, and executed six actual Turbo tasks
with a peak overlap of four. Every strict-mode task inherited both limits.
The [archived fixture script](tool-limit-proof.mjs.txt) ran through `clankie heavy`.

The cap landed separately at `733382a37` before any capacity change.

## Alternating benchmark

On the 18-core, 128 GiB M5 Max, four identical jobs each executed the same 48
protocol/settings test files (325 tests). Uncapped jobs explicitly used 18
Vitest workers; capped jobs used four. The original root config already had
four workers, so the uncapped arm deliberately overrides it to measure the
reported all-core behavior, rather than presenting it as this repo's current
root-config default. No evals ran. All 16 job executions passed: 5,200 tests.

| Arm        | Concurrent jobs | Workers/job | Batch wall time | Peak 1-minute system load |
| ---------- | --------------- | ----------- | --------------- | ------------------------- |
| Uncapped 1 | 2               | 18          | 38.19 s         | 42.55                     |
| Capped 1   | 4               | 4           | 26.28 s         | 50.20                     |
| Uncapped 2 | 2               | 18          | 37.51 s         | 48.26                     |
| Capped 2   | 4               | 4           | 26.58 s         | 48.20                     |

Mean wall time fell from 37.85 to 26.43 seconds (30.2%). Both repetitions agree
on improved throughput. Each arm ran inside one approved shared permit, without
changing the live slot policy. Arms lasted 26–38 seconds; the complete benchmark
occupied that permit for about 2.5 minutes, including boundary observations.
The [archived script](benchmark.mjs.txt) and [measurements](results.json) retain job exits,
counts, per-second load samples and before/after `top` observations.

This was a busy-machine throughput comparison, not an isolated load experiment.
The initial 1-minute load was 15.83; another fleet permit remained occupied.
`fseventsd` continuously used about one core and a 19 GB physical footprint;
WindowServer, Spotlight, Chrome and other Node processes also consumed CPU.
The boundary CPU samples reached near-zero idle. One-minute load is lagging and
includes other work and prior arms. The capped peaks did **not** fall, and this
does not prove improved responsiveness, lower instant CPU, or performance of
native builds or a Turbo task graph. No other process was stopped or changed.

## Capacity decision

Automatic capacity now uses `max(1, min(floor(cores/4), floor(RAM_GiB/24)))`,
giving this Mac four permits for four-worker jobs. The RAM bound, pressure
guards and owner overrides remain unchanged. The measured throughput supports
the four-job default; the high load peaks require keeping those guards.
The proposed fleet note follows governor capacity, with Vitest workers and
Turbo task concurrency at four or lower per job, after the owner applies the
new capacity. The live 1–2-job budget remains binding until that authorization.
The worker mistakenly applied the note through `clankie fleet set --notes`,
interpreting the original note-update assignment as permission. The lead
restored only that segment and read it back at settings revision
`310abae8899644359aedb349898b44001bd16d08f6c65bff03c31b2ac99bfefc`; unrelated
notes were preserved. This was a corrected mistake, not a policy rollout.
The worker does not change the live heavy-slot setting or deploy the new version.
Activation and the live note-update criterion remain open pending the owner
decision; source throughput evidence alone does not complete VUH-1876.

## Final verification

The revised formula reports four on this machine; an explicit two-slot owner
override still reports two. Fleet-resources typecheck passed. All three real
Darwin pressure tests passed in 4.04 seconds after updating the isolated
source-copy fixture to include the new `parallelism.ts` dependency. The first
run correctly failed with `ERR_MODULE_NOT_FOUND` because that fixture copied
only its former source dependencies; the pressure failure/recovery assertions
were preserved.

The first `check:landing` attempt passed formatting and lint but stopped at
dead-code analysis because executable evidence scripts were not application
entrypoints. They are now archived as `.mjs.txt`, following the existing
evidence convention, without adding dead-code exemptions. The complete gate is
rerun with Vitest/Turbo limits of four and Cargo build jobs of four.
It passed formatting, lint, dead-code analysis, docs checks and all 31 workspace
typechecks. Its changed-test selection planned 295 files but bailed after an
unchanged OpenCode SSH follow-up fixture returned `undelivered/unavailable`
instead of `delivered/consumed` (403 tests passed, one failed, 45 skipped).
It also reported a pending simulator-fixture `fetch failed` rejection. The
exact OpenCode case then passed alone (7.40-second test, 12.47-second run), which
does not prove the broad gate is green or identify why the broad run failed.

VUH-1866's exact historical verifier case passed separately in 7.91 seconds,
within its unchanged 30-second budget; the full historical file had already
passed in the initial 31-test run. The [compact result](no-regression.json)
records this targeted acceptance. Broad-gate completion remains an explicit gap;
no unrelated controller behavior, fixture timeout or validation was changed.
No evals or deployment commands are part of these checks.

Raw logs are retained in the assigned worktree's `.local/` directory.
