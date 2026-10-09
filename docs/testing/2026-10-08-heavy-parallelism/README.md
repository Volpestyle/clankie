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

The cap lands separately before any capacity change. The approved benchmark
will run four identical jobs over protocol and settings tests, comparing two
uncapped processes with four capped processes, in alternating 2/4/2/4 order.
Each arm runs inside one owned shared permit. Load samples include other fleet
and system work; no live slot setting is changed by this worker.

Raw logs are retained in the assigned worktree's `.local/` directory.
