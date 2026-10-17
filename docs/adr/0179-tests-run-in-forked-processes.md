# ADR 0179: Tests run in forked processes

Status: accepted (2026-10-17, [VUH-2396](https://linear.app/vuhlp/issue/VUH-2396)):
`pool: "forks"` has run every root suite since
[VUH-1358](https://linear.app/vuhlp/issue/VUH-1358). Amended 2026-10-06 through
2026-10-12 to run bounded parallel forks; the current configuration is below.

## Context

The root Vitest suite ran on the `threads` pool. On Node v26.7.0 (Homebrew,
macOS) full runs intermittently died with SIGABRT before reporting any failing
test. Every crash report had the same stack: `node::worker::Worker::Run` →
`WorkerThreadData::~WorkerThreadData` → `Isolate::Deinit` → `Heap::TearDown` →
`MarkingWorklists::~MarkingWorklists` → `POINTER_BEING_FREED_WAS_NOT_ALLOCATED`.
The fault is in Node/V8 when it disposes a worker isolate, not in any test, and
it takes the whole Vitest process down with it.

Options weighed:

- **Pin an older Node.** Fixes nothing for anyone who runs a newer Node, and
  `engines.node` is `>=24`.
- **Keep `threads` and wait for an upstream fix.** Leaves `pnpm check` flaky
  for every agent in the meantime.
- **`pool: "forks"`.** Each test file runs in a `child_process` instead of a
  `worker_thread`. No worker isolate gets torn down, so the crashing code path
  is never reached, and this pool works on every Node version.

## Decision

`vitest.config.ts` uses `pool: "forks"`: every test file runs in a
`child_process`, never a `worker_thread`. When this was decided the suite ran
one file at a time (`fileParallelism: false`), so the extra cost of a process
over a thread was small. On an M5 Max with Node v26.7.0 the full root suite
(269 files) took about 85s with forks, against 76s for the one threads run that
finished (4 of 5 threads runs aborted). That is about 12% slower, a fair price
for a gate that finishes.

Once Node's worker teardown is fixed, returning to `threads` is a one-line
change, but only worth it if the speed gain can be measured.

## Current configuration (2026-10-17)

- `pool: "forks"`, `fileParallelism: true`, `retry: 0`.
- `maxWorkers` is 4 locally and 3 when `CI` is set. An inherited
  `VITEST_MAX_WORKERS` takes precedence; `clankie heavy` full permits pass 4 and
  keep a lower value the caller set.
- `integrate.integration.test.ts` and `integrate-remote.integration.test.ts` run
  in a later `serial-integration` project with one worker.
- Release and queue-landing retries rerun each failed file alone, with one
  worker and no file parallelism.
- Each fork has its own temporary HOME, temp directory and stores.

## 2026-10-06: bounded parallel forks

[VUH-1762](https://linear.app/vuhlp/issue/VUH-1762) found that the expanded full
suite spends over 20 minutes serializing file imports and test waits. Vitest
then ran at most two isolated forks inside the fleet heavy permit. Each file still
gets its own temporary HOME and stores. The fork pool, suite selection and
disabled retries remain the same; Node's worker-isolate teardown is still avoided.
The [gate evidence](../testing/2026-10-06-gate-stability/README.md) records the
historical failures, cause repairs and before/after measurements.

## 2026-10-07: four forks

Four forks replaced two (VUH-1762): the same four representative suites took
46.0s instead of 79.6s, 42% less
([gate evidence](../testing/2026-10-07-gate-stability/README.md)).

## 2026-10-11 and 2026-10-12: three forks in CI, serial queue proofs

CI defaults to three forks, keeping four locally: the three-core macOS runner
needs CPU for Vite transforms, the coordinator and real fixture children too
([VUH-2101 measurements](../testing/2026-10-11-release-ci-concurrency/README.md)).
The remote queue proof moved to a later one-worker project (VUH-2119), and the
local one joined it the next day (VUH-2164), so competing fixtures cannot expire
their deliberately short deadlines.
