# Three-core release CI concurrency — VUH-2101

Tracks: https://linear.app/vuhlp/issue/VUH-2101/macos-release-check-is-load-sensitive-on-3-core-runners

Default to three Vitest forks in CI instead of four, keeping the local
four-fork default and parallel files. The three-core macOS runner needs CPU for
Vite transforms, the coordinator and real fixture children as well as test forks.
The manual CI job allowance changes from 45 to 60 minutes and the macOS tag
release job from 45 to 65 minutes, as explicitly directed by the lead after
full-suite and remaining-step measurements.
All per-test/hook/fixture deadlines, budgets, retry-zero, test selection, workflow
checks, ordinary CI's 30-minute ceiling and eval boundaries remain unchanged.
Juno owns the two latest failing fixtures under VUH-2095 and is the sole next
manual macOS dispatcher after both fixes land.

## Historical CI

The requested worktree was created from fetched `origin/main` at
`f87cdbe4fae158a8e354712d9eb5783b17ef0b6d`.

| Run                                                                                                | Revision                                   | Vitest wall time | Result                                                                                                       |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------ |
| [38112212045 attempt 1](https://github.com/Volpestyle/clankie/actions/runs/38112212045/attempts/1) | `223c56fcd0a760119f93356bd9aa0ce0da47222f` | 996.04 s         | 7,840 passed / 84 skipped; subsequent standalone load gate failed health p95 337.63 ms > 250 ms              |
| [38112212045 attempt 2](https://github.com/Volpestyle/clankie/actions/runs/38112212045/attempts/2) | `223c56fcd0a760119f93356bd9aa0ce0da47222f` | 1,134.31 s       | 7,837 passed / 3 failed / 84 skipped; SSH recovery and native/observer health fixtures, fixed by `914fbe937` |
| [38116629927](https://github.com/Volpestyle/clankie/actions/runs/38116629927)                      | `914fbe937871c2ad177e94eac75ec3c8170ecfb5` | 1,182.75 s       | 7,857 passed / 2 failed / 84 skipped; detached helper readiness and SSH OpenCode lifecycle                   |

Retained logs come from `gh run view --log-failed`, with explicit `--attempt 1`
and `--attempt 2` for the rerun. The first attempt's full log supplies its
successful Vitest timings. Default `--log-failed` on the rerun returns attempt 2.
The load gate executes after Vitest and Rust/IPC tests exit. These records do
not prove that Vitest contention caused its separate health-p95 failure.
The latest job spent 8m 45s in `pnpm check` before starting Vitest, and 30m
overall before its failure. A focused timing comparison cannot establish the
full suite's duration, which the next manual run must measure.

## Full-suite duration and job allowance

`estimate.py` parses every reported file duration from the full CI logs and
replays longest-first scheduling into two, three and four slots. Reported file
times sum to Vitest's execution summary within 0.03 seconds. These omit imports,
transforms, setup and scheduling, so the estimate retains observed wall time
minus the four-slot execution makespan, scaling that overhead by `4 / workers`.
This assumes unchanged per-file costs, not a measured speedup from reduced
contention. Summed published phase work provides an independent cross-check.

| Run                     | Reported executed files | Sum of file execution | Observed four-fork Vitest | Estimated two-fork Vitest | Estimated three-fork Vitest |
| ----------------------- | ----------------------- | --------------------- | ------------------------- | ------------------------- | --------------------------- |
| `38096093705` (green)   | 872                     | 2,994.178 s           | 21.45 min                 | 42.89 min                 | 28.60 min                   |
| `38112212045` attempt 1 | 875                     | 2,154.102 s           | 16.60 min                 | 33.20 min                 | 22.13 min                   |
| `38112212045` attempt 2 | 875                     | 2,237.317 s           | 18.91 min                 | 37.81 min                 | 25.21 min                   |
| `38116629927`           | 877                     | 2,584.317 s           | 19.71 min                 | 39.42 min                 | 26.28 min                   |

The two-fork estimate from the latest run exceeds 49 minutes before remaining
checks when its 8m45s pre-Vitest work and 1m22s job setup are included. Two
forks were rejected rather than trusting the six-file matrix to represent the
whole suite. Three forks reduce fork concurrency by 25% with a smaller throughput
cost and no suite classification or scheduling project to maintain.

Measured [green manual run 38096093705](https://github.com/Volpestyle/clankie/actions/runs/38096093705)
spent 147 seconds on `check:load` and 158 seconds on the final release-mode Vox
build. The partial first attempt's post-Vitest Rust/IPC work took about 76
seconds. Adding those to the latest-run three-fork estimate gives approximately
42.7 minutes overall, only 2.3 minutes below the former 45-minute ceiling.
Replaying the green run's own timings is more conservative: its observed job
lasted 43m40s, so the extra three-fork Vitest work predicts about 50.8 minutes.

The lead explicitly directed a 60-minute allowance for the manual CI job when
the estimate was within five minutes of 45. Only `workflow_dispatch`'s job
ceiling changes in CI. The contention fix is the three-fork default. All individual
hang deadlines and gates remain enforced. These estimates remain subject to real runner variance;
Juno's one next manual run must establish the actual duration and load outcome.

## Tag-release allowance

The lead then explicitly included the macOS tag-release job in this change.
[v0.4.3 run 38101590636](https://github.com/Volpestyle/clankie/actions/runs/38101590636)
and v0.4.2/v0.4.1/v0.4.0 failed before archive build and smoke, so their skipped
steps provide no duration evidence. The latest completed tag archive/smoke is
[v0.3.3 run 36783485069](https://github.com/Volpestyle/clankie/actions/runs/36783485069),
revision `9614e93d04ec478f993ef7e2ca399e19294efa20`:

| Step            | Started (UTC, 2026-09-30) | Finished | Duration      |
| --------------- | ------------------------- | -------- | ------------- |
| `release:build` | 22:19:28                  | 22:23:02 | 214 s (3m34s) |
| `release:smoke` | 22:23:02                  | 22:23:47 | 45 s          |

Adding both complete steps to the 42.7-minute projection gives **47.0 minutes**.
Adding them to the more conservative 50.8-minute green-run replay gives
**55.1 minutes**. The macOS tag job allowance becomes **65 minutes**, about
ten minutes above that conservative estimate. This intentionally double-counts
the final manual Vox build already in the projection: `release:build` also
compiled Vox (2m50s in that older run). Using whole-step durations is conservative
and avoids assuming reuse or subtracting an unmeasured current archive cost.
The older archive layout and runner/cache variance limit this estimate; no
current release build or publication was performed. Linux job allowances stay
45 minutes; test/process deadlines and check selection stay unchanged.
The withdrawn waiting integration batch is `c2d80556-25cb-4e25-83ba-242463562d8d`;
the replacement combines concurrency and both job allowances.

## Scheduling and fixture inventory

`pnpm check` invokes one root Vitest run through `pnpm test`; it does not run
every package's Vitest script concurrently through Turbo. Typechecks precede
tests; Rust tests/IPC smoke follow Vitest. One root project includes all ordinary
test files; package-local invocations only narrow the include pattern by cwd.

The baseline uses `pool: "forks"`, `maxWorkers: 4`, `fileParallelism: true`,
default isolation, sequential cases within each file, and `retry: 0`. There
are no explicit `.concurrent` test/suite declarations in the ordinary test
directories. Vitest 4.1.10's default `maxConcurrency: 5` therefore does not
multiply this workload. Four file workers exceed three cores before their
children or the coordinator consume CPU. Child processes and worker threads
are outside the Vitest worker ceiling.

Vitest's installed `resolveConfig` sets `maxWorkers` from `VITEST_MAX_WORKERS`
after reading config. That override is preserved: fleet heavy permits supply
their own limits. Stock GitHub CI does not set that variable. No project-specific
worker override or additional pool is configured.

Direct source searches retained as `process-suites.txt`, `service-suites.txt`
and `timed-suites.txt` find 164 files importing `node:child_process`, 254 with
`createServer`/`serve` constructs and 160 with timers/elapsed-time constructs.
These overlap, include mocked constructs, and miss children hidden in imported
helpers; they are discovery heuristics, not measured live-process counts.

| Suite / family                                                                         | Actual resource work and headroom assumptions                                                                                                                             |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime-health-native.integration.test.ts`                                            | Native proof compilation, isolated real Herdr, service HTTP, receiver process, CPU-burning worker threads; sustained CPU and slow health must be observed before recovery |
| `runtime-health-observer.integration.test.ts`                                          | Real Node observer child and slow HTTP server; CPU-time burn and timer/health samples must overlap within the bounded fixture lifetime                                    |
| `fleet-ssh-recovery.integration.test.ts`                                               | Real shell/Node SSH-command fixtures and resident relay, streams and socket readiness; these exercise the SSH adapter without contacting an external SSH account          |
| `opencode-fleet-lifecycle.integration.test.ts`                                         | Captain imports, SQLite and real HTTP/WebSocket/RPC sockets; SSH helper/forward process objects and SDK/Herdr inputs are fixtures, not live SSH processes or a model      |
| `runtime-helper-lifetime.test.ts`                                                      | Service process group and independently detached helper, readiness and survival after group exit; Juno owns its readiness fix                                             |
| `native-process-transport.integration.test.ts` and fleet-resource integration families | Real Node helper/process lifetimes and cleanup; fleet-resource suites additionally inspect process identity/census, burn CPU and sample owned process groups              |

## Local comparison

The four/two-worker comparison ran at `cdd373cab41ca375c2bccea59cff1322ba8c6200`.
All four passes completed 52 tests, with one skipped, across the same six files.
The matrix ran through `clankie heavy` and reused
`packages/fleet-resources/src/server-cpu.py` plus the native process identity
boundary to apply a sampled three-core budget inside the heavy permit's owned
process group, excluding the older supervisor/matrix-shell process lifetimes.
The baseline and candidate use identical selected files and unchanged deadlines.
Order is four, two, two, four workers to expose order/ambient-load variance.

| Order / forks | Vitest duration | Whole command | Peak sampled processes | Charged mean cores | CPU observation-loss events |
| ------------- | --------------- | ------------- | ---------------------- | ------------------ | --------------------------- |
| 1 / 4         | 108.79 s        | 126.14 s      | 15                     | 1.33               | 6                           |
| 2 / 2         | 110.94 s        | 131.48 s      | 11                     | 1.45               | 14                          |
| 3 / 2         | 140.32 s        | 142.22 s      | 11                     | 1.53               | 14                          |
| 4 / 4         | 97.60 s         | 118.53 s      | 15                     | 1.62               | 10                          |

Four-fork median Vitest duration was 103.20 seconds; two-fork median was 125.63
seconds, about 22% slower. Peak process fan-out fell from 15 to 11. This supports
reducing fan-out but does not prove a speedup or reproduce the historical CI
failures. The native process suite's real silent-child deadline/kill checks passed
at both limits, so hang detection still exercises the same bounded behavior.
The sampler's discovery wrapper was adjusted after the first pass to skip
kernel-proven zombies; the reused governor and three-core allowance did not change.

This is a CPU-bandwidth simulation on the shared Mac, not physical three-core
affinity or a GitHub hardware reproduction. Sampling permits short bursts;
reaped child CPU can be conservatively double-charged. Detached fixture children
escape the process group and budget. Native subprocesses still undergo their
real test teardown. Host load and the observed peak group-process count are
retained, rather than treating configured workers as total process count.

The retained `reproduction.tar` holds the inventories, resolved configs, runner
step timings, formatter log and manual reproduction scripts. Its `constrained.py`
and `compare.sh` are manual reproduction artifacts;
restore them under `.local/release-ci/` in the tested worktree to run the matrix.
No benchmark script becomes a repository check. Final three-fork acceptance
runs on `cf61cc10a9b0af7558b84d6b9bc40c8a7d137269`, after Juno's two fixture
changes landed; its timing is not a same-input comparison with the earlier matrix.

## Verification and gaps

The resolved Vitest config is retained for local, CI and a lower explicit
environment override (`resolved-config-final.jsonl`: local four, CI three,
explicit lower override one). It confirms one project, isolated forks, parallel files,
30-second test/hook deadlines, zero retries and the same include/exclude patterns.
Final three-fork acceptance completed **6 files / 52 passed / 1 skipped** in
**92.65 seconds**, exit **0**. The entire governed command took 94.09 seconds,
with 15 peak sampled processes. This includes Juno's landed fixture changes,
so its faster time is not evidence of a concurrency speedup. Both the previously
failing cases and real silent-child deadline/kill cases passed. Raw JSON and log
are retained in `acceptance-3.json` / `acceptance-3.log`.
Formatter output for the combined change is retained in `formatter-combined.log`. The managed integrator's landing
receipt and subsequent manual CI outcome are posted on VUH-2101 when available.
No local full root gate is run for this assignment.
The manual macOS run is needed to establish whole-job stability and its effect
on the separate load gate. An absence of local failures alone proves neither.
