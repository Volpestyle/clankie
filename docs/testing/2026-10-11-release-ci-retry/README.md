# Release-only failed-file retry (VUH-2101)

Tracks [VUH-2101](https://linear.app/vuhlp/issue/VUH-2101/macos-release-check-is-load-sensitive-on-3-core-runners).

Four release checks have failed on different load-sensitive cases. The latest
[manual run 38121821468](https://github.com/Volpestyle/clankie/actions/runs/38121821468)
failed one test after 7,889 passed and 85 skipped: the worker-bridge-health
fixture's initial catalog exceeded its existing 500ms request budget. Vitest ran
for 1,346.85 seconds. Juno owns that fixture repair; this change handles the
release check's failure policy without changing that budget.

## Accepted behavior

The lead explicitly authorized one isolated rerun of every failed Vitest file
for the manual macOS and tag-release jobs only. `scripts/check-release.mjs` first
runs the unchanged full `pnpm check`. A complete reporter record identifies every
selected file, completed result and unhandled error, with a fresh run identity.
Non-test failures, cancellation and incomplete/stale/unhandled-error reports
block recovery.

Each failed file gets exactly one new Vitest process, one worker, file
parallelism off and retry zero. The config's exact include path avoids positional
substring matching. The rerun must actually run only that file, and every
previously executed case must be present and pass; turning a failed case into a
skip cannot recover it. Every failed file is attempted even after another fails
or the two-flake ceiling is exceeded. An interrupted job stops and fails.

All reruns must pass, and at most two files may recover. The job summary prints
`Flaky on first attempt`, including on a blocked check, and lists failed reruns.
First-attempt results, isolated reports/JUnit and the summary stay in `.data/qa/`
for the existing artifact upload. Ordinary push/PR CI and direct `pnpm check`
retain retry zero. No checks, per-test deadlines, performance budgets, job
ceilings or eval selection changed.

The initial `pnpm check` stops at Vitest before Vox tests and IPC smoke because
its test script uses `&&`. After successful recovery the wrapper runs those two
original commands; their failure still blocks. A guard compares the current
package test script and check sequencing before starting, failing closed if a
future edit changes the continuation contract. Load checks, build and release
smoke remain ordinary subsequent workflow steps.

## Focused proof

Installs and tests ran through `clankie heavy`; final touched-file formatter and
lint ran directly under the lead's interim VUH-2102/2103 rule. Earlier governed
formatter/lint commands completed before cancellation was needed. Fresh base:
`bd19adeee8dd3be5de01bdc861a49657a41e46e7`, Node26.7, Vitest4.1.10.
The acceptance suite creates scratch repositories and starts real forked Vitest
processes with real reporter output and filesystem attempt counters. It does
not mock commands or reporter results. It proves:

- two recovered files accepted; an overlapping passing filename stays at one attempt;
- three recovered files blocked after all three rerun once;
- a persistent assertion failure and an actual bounded hang fail twice, while later files still rerun;
- a failed case becoming skipped blocks recovery;
- unhandled errors, incomplete/missing and stale reports block without retries.

The initial focused run passed 5/5 in 16.19s. Final CI-mode focused proof passed
5/5 in 9.60s with the release reporter and JUnit enabled; its run record reports
one selected file, five passed cases and no unhandled errors. These timings vary
with machine load and do not establish a speedup. The bounded hang's 100ms is
an intentionally short scratch-fixture deadline, not a changed product timeout.
Formatter, focused lint, workflow YAML scope and diff-whitespace checks passed.
The full root gate was not duplicated locally. Managed integration supplies the
landing gate. Full production orchestration remains unproven until Juno's one
agreed macOS run after both changes land; no run or release was dispatched here.

Raw logs, CI-mode JSON/JUnit and source snapshots are indexed in `evidence.json`.
