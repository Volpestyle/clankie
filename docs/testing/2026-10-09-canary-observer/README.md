# Foreign canary observer — VUH-1953

Issue: https://linear.app/vuhlp/issue/VUH-1953. Base for reproduction and initial
verification: `6de102306f1553405bc749fc48b349179dd31e68`.

The archived `verification.json` bundles the exact named logs, five acceptance
snapshots and SHA-256 hashes of the changed source files. Log names below refer
to its `logs` entries; captured JSONL rows are its `acceptanceSnapshots`.

## Reproduction before the fix

`reproduction.log` retains a real failing child-process/HTTP run. Candidate
PID `10088`, instance `8571c9d4-3b53-4d94-894e-3ab1606987a3`, boot commit
`bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`, had already answered healthy HTTP.
A second child, PID `10465`, boot commit `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
recovered the same private latest update journal. It made zero health requests,
wrote bare `runtime-canary-runtime-changed`, and retained the candidate's PID,
instance and start time in the failed record. The unchanged candidate's hold
remained established. The acceptance test failed as expected (exit 1).

This proves the foreign-observer failure mechanism. The historical failing
writer's actual commit was never retained; this run does not identify it.

## Change

A runtime at a different boot commit leaves the pending candidate alone while
its armed process is alive or its exit is unproven. After a confirmed armed PID
exit, a different boot must serve verified healthy HTTP before failing the
interrupted window; recovery defers this probe until HTTP admission. It rereads
the journal after the probe to avoid replacing a recovered observation. The candidate continues to sample its complete immutable boot
identity over fresh HTTP. A same-commit restart still begins a new full window,
as the existing restart contract requires. Passed-checkpoint recovery still
refuses a different commit; holds and previous healthy checkpoints retain their
existing ownership checks.

Both sampler and canary identity errors retain the first differing field and
expected/actual values in the existing bounded error string. No new durable
record fields bypass the strict reader. Unusually long paths are explicitly
truncated. Availability retries and budgets are unchanged.

## Verification

`final-focused.log`: all 38 canary and health-sampler integration cases passed
(exit 0), including unchanged candidate plus foreign observer, genuine
same/different-commit HTTP replacement, recovery after a confirmed candidate
exit, transient misses, sustained failures, restart accounting, and hold
ownership/rollback contracts. `focused.log` retains the earlier 28-case pass.

`capture.log`: all eight selected acceptance/identity cases passed (exit 0).
`acceptance.jsonl` retains five inspected snapshots: the foreign observer leaves
the pending identity/start time untouched; the unchanged candidate passes its
full window and releases its hold; real HTTP replacement children on the same
and different commit fail with both instance/commit values; a different boot
serving verified healthy HTTP fails recovery after the armed candidate exits.
The sampler cases verify diagnostics for all four fields over real HTTP.

The acceptance capture uses actual spawned children, loopback HTTP, private
update records and the real deploy-hold registry. Its controlled clock advances
only at sampling boundaries, as the existing fixture does; CPU and HTTP latency
are measured from the real process and request. Replacement switches the
candidate observer's health endpoint to a separate real child HTTP server.

## Gaps

No historical observer identity was recovered. No live deployment, service
restart, production hold override or eval ran. The owner deploys and closes.
