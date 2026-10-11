# Remote gate execution deadlines

VUH-2099 bounds each remote install/gate at 90 minutes total and ten minutes
without stdout or stderr. The existing progress observer reports remote silence
after three minutes. Gate-report collection is bounded at two minutes. Placement,
staging and cleanup retain their existing independent deadlines.

On timeout, only the request's owned transport receives TERM and, if it remains
alive, KILL after one second. Closing the transport does not attest remote
success or prove that a detached remote compiler stopped. The remote workspace
cleanup is bounded separately. The queue retains the cause and remote output,
then freshly installs and gates the exact composed tree locally. Withdrawal and
durable cancellation fences still apply before landing.

## Calibration limits

The bounded scan of retained PC gate records found completed partial failures
lasting 154.27 and 180.05 seconds. The stalled `825627bf` gate was interrupted
without a completed result. No successful full PC gate was measured here.
The [remote-gate author's report](https://linear.app/vuhlp/issue/VUH-2099#comment-57884e3c-cab1-41d8-8cb6-54a4c8106f26)
states legitimate full PC gates take about 20–40 minutes and cold Rust builds
can remain quiet for several minutes. Ninety minutes gives margin above that
reported range; ten minutes of silence allows quiet builds while the observer
still alerts at three minutes. A successful retained full-run measurement
remains needed for tuning. The initial 30-minute/five-minute proposal based only
on partial failures was withdrawn before gating; request `f7cf346c` is cancelled.
No PC process, shell, Herdr session, checkout or service was changed for this work.

## Verification

Real-process remote integration tests use the shipped WSL script through a
local POSIX transport, a real Git origin and composed tree, a separate private
home/toolchain, actual pnpm install/gate commands and durable selection reports.
This proves the transport and fallback boundary; it is not live PC acceptance.

The added cases cover stdout/stderr resetting the silence deadline, a silent
gate reported as stalled, a continuously emitting gate hitting its total
deadline, and a hung report fetch. Each failed transport retains its cause,
freshly gates locally and allows a later request to complete. A silent transport
ignoring TERM is confirmed killed; a chatty one may exit when its output pipes
close, so its assertion checks confirmed termination rather than requiring a
particular signal. Existing 23 integration cases also passed, including Wren's
isolation/withdrawal/restore behavior.

The first two remote fixture runs were interrupted after confirming the owned
wrapper identity, because the test matcher failed to decode nested shell
quoting. The corrected run passed eight of nine cases; the remaining assertion
incorrectly required SIGKILL when a chatty child had already exited. These runs
are retained as failed/interrupted evidence, not reported as passing gates.

Final focused results: 10/10 remote integration cases passed in 86.52 seconds,
23/23 integration/isolation cases passed in 134.92 seconds, and the service
typecheck passed on the final source. Formatting and `git diff --check` passed.
The [evidence archive](clankie://evidence/sha256/e3eae2630e66d9e960289a373201f4fb8280a049b04c0710ef47e1e16f32f01b)
retains the raw checks, earlier failed run, PC duration inventory and pre-commit
patch. After review found that buffered writes could reset silence while
draining, the final source clears that timer again; all ten remote cases and
the service typecheck passed again. The [supplemental archive](clankie://evidence/sha256/890e483187385a7ac04178a893af421a649c126adcdbfce3e602f9e615a5cd9c)
retains that exact source and its recheck results.
Both dependencies landed before this change was submitted: VUH-2090 at
`cdd373cab`, followed by VUH-1701 slice 3 at `cf61cc10a`. The latter's
[confirmed gate and push](clankie://evidence/sha256/c3fd6579e95fb5764b657a05b0590544fbfe50dbe44c37879858d04f7ef1fe1b)
records exit 0, 6,412 passed / 61 skipped tests and 700 passed / 22 skipped files.
Only this change was rebased onto fetched main; copied dependency commits are
excluded. On fetched `cf61cc10a`, [fresh-main verification](clankie://evidence/sha256/c5fae2ba710d8346b7a02549356ed32ce01eb34b721c42d168190066100d4e3f)
passed all 33 focused tests in 138.31 seconds and the service typecheck.
Its own authoritative integrate gate remains required. No duplicate
local root gate, fleet load test or eval.

After calibrating defaults to the remote author’s reported durations, the
[corrected-source recheck](clankie://evidence/sha256/3893882d8d1dd6359040c9f0cfcb79dfbbf17f8055f6e9f27dca268cb80b5a79)
passed 33/33 focused tests in 135.92 seconds and service typecheck on
`cf61cc10a`. Earlier results above precede this default-only correction.
