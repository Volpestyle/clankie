# VUH-2481: wait for terminal frames on the existing stream

Tracks: https://linear.app/vuhlp/issue/VUH-2481

Base: `dc1a966a5f3ded54c0b2a9defa0e2e8573c0fcbd` (fetched `origin/main`).
Branch: `fix/vuh-2481-terminal-frame-wait`.

The failing assertion read `frames[0]` from a valid empty page. The terminal
store waits up to 250 ms for observer output, then returns an empty page with a
usable cursor. Starting the observer subprocess can take longer under load.
The runtime maps each delivered frame's ID to the pinned connection; it does
not promise that the first page contains a frame. The protocol also permits
empty frame arrays. This is a test readiness bug, not a routing or ordering bug.

The fixture withholds its first frame until the initial tail returns. The test
asserts that the initial page is empty, releases the frame, and polls with the
returned cursor until a nonempty page arrives. Unexpected statuses fail
immediately. Keeping the cursor matters: a cursorless poll creates a fresh
observer. The existing ID, socket, restart, disconnect, endpoint replacement,
and in-flight attach assertions remain in place. Production code and its poll
timeout are unchanged.

Verification uses `clankie heavy -- node .local/vuh-2481/loop.mjs`: two concurrent
Vitest processes, each running 25 iterations with `VITEST_MAX_WORKERS=2`.
Each iteration runs `runtime-terminals.test.ts`, `herdr-terminal.test.ts`, and
`herdr-terminal-control.test.ts` together with file parallelism enabled. This
bounds the owned load to four workers and exercises the delayed first frame
on every routing-test run. No test retries are enabled. The retained raw proof
contains the runner, individual logs, exit statuses, source diff and a fleet
resource sample.

Result: **50/50 routing runs passed**, with all 150 file runs and 800 test
executions passing (16 tests per iteration), exit 0. The loop ran from
`2026-10-19T00:42:14Z` to `2026-10-19T00:45:03Z`. The focused test and explicit
touched-file formatting check also passed. The root landing gate is recorded
in the final issue finding and `.local/vuh-2481/landing.log`.
