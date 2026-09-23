# ADR 0179: Tests run in forked processes

Status: proposed. Tracked by [VUH-1358](https://linear.app/vuhlp/issue/VUH-1358).

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

`vitest.config.ts` uses `pool: "forks"`. The suite already runs one file at a
time (`fileParallelism: false`), so the extra cost of a process over a thread is
small. On an M5 Max with Node v26.7.0 the full root suite (269 files) took
about 85s with forks, against 76s for the one threads run that finished (4 of 5
threads runs aborted). That is about 12% slower, a fair price for a gate that
finishes.

Once Node's worker teardown is fixed, returning to `threads` is a one-line
change, but only worth it if the speed gain can be measured.
