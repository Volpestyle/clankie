# VUH-2548: reclaim integration caches while the queue is busy

Tracks: https://linear.app/vuhlp/issue/VUH-2548

The first change limits busy-queue reclamation to finished batches' copied
`isolation/{core,app}/{pnpm-store,npm-cache}` download stores. Installs copy package
contents into `node_modules`. The busy path does not remove worktrees, installed
dependencies, private environments or Git stores, and never rewrites records.
The existing idle sweep and automatic terminal cleanup retain their behavior.

## Live measurement

A source `IntegrationQueue.reclaimWorktrees()` invocation ran under `clankie heavy`
against the existing integration directory, without deploying or restarting the
runtime. At 2026-10-20T10:18:15Z it reported nine removed stores, **11,384,315,904
allocated bytes (10.60 GiB)**, and no retained errors. Batch
`b061c109-b615-44a6-b7f5-f8bc7ec851cf` was gating during the sweep; its eventual
landing was confirmed: core pushed at
`279fb1235856a2d007445c4313b1b48f8da61169`, with its push receipt confirmed.
Its gate passed 751 test files / 6,706 tests.

| Measurement               | Allocated KiB |    GiB |
| ------------------------- | ------------: | -----: |
| Before, 10:15:14Z         |   109,310,400 | 104.25 |
| After, 10:18:58Z          |    90,182,648 |  86.00 |
| Total directory reduction |    19,127,752 |  18.24 |

The directory reduction also includes the existing queue's automatic cleanup as
its earlier batch finished. Only 10.60 GiB is attributed to the new code path.
Before/after hashes found **zero preservation violations**: existing historical
gate/install logs, request receipts and retained refs remained intact. Active
logs were allowed to grow. Raw measurements, exact removed paths and queue
status are in the evidence manifest.

## What remains

A reclaimed core-only batch (`195269f8…`) measured 52.6 MiB, including 51.7 MiB
of retained Git data and its logs, rather than the earlier reported 3.3 GiB.
Per-batch private Git stores explain much of the total: roughly 50 MiB for core,
or 350 MiB for core plus app. They preserve history and restore objects and are
not deleted by this change. Before reclamation, passed/held worktrees accounted
for 12.21 GiB, their isolation for 13.21 GiB, the then-live gate for 3.21 GiB,
and the failed shared retry source for 7.43 GiB. Other data was predominantly
retained repository stores and logs.

Batch `cafb726e-1dfd-4325-b9de-b28da377990b` was an active retry source at the
initial census. Its VUH-2549 gate log and fixture manifest were independently
confirmed in the evidence store before any live cleanup:

- [Gate log](clankie://evidence/sha256/d1cedcbf74afbb25ce9ad9b5b52740567cd28370ecd39236e5e512f47e1f094d)
- [Manifest](clankie://evidence/sha256/c05a3cd0fa84abc1a04c2ece6e95db026fd4b37a7c14c6a11f1a64cf344e40f4)

## Checks and limits

The cache-only regression uses real Git repositories, a real install/gate and
separate queue instances. While one gate is blocked, reclamation removes a failed
attempt's and a retained pass's stores, leaves their records byte-identical and
their worktrees/node_modules intact, and preserves a retained ref. Releasing the
gate lets it push; the retained pass then pushes too. The unknown-owner regression
also passes. Focused checks: **2 passed**. Scoped lint and formatting passed.

The root `pnpm check:landing` passed for
`c1554604450cd61208e8f8ccca072bae029f33fb` against fetched
`cefe5579b855ddaccec756a73688de5e3bbadc17`: exit 0, 441.57 seconds,
five affected compiler packages and twelve selected tests passed. Earlier
attempts stopped on raw-proof formatting and catch-all filesystem checks; raw
proofs now live in the evidence mirror, and only ENOENT is tolerated as missing.
The cache-only candidate was submitted once with `--push --no-wait` as request
`cfaa5994-db04-4d80-953a-3010264dfe4c`. A lead deployment interrupted that
pre-upgrade request. The lead resubmitted the same candidate as
`49a67b46-008c-405a-918f-910b109ef6eb`; landing remains pending.
The separate tree-reclamation change is based on VUH-2534's landed main
`279fb1235856a2d007445c4313b1b48f8da61169`. Its real-Git regressions cover queued
lineage, recoverable interrupted sources before retry claims, the lifetime of
`interruptionRetry.batchId`, and shared failed-to-retry admission. Each source
stays protected while needed and is reclaimed after the request finishes; its
log and retained ref survive. A fifth case covers gate-reuse dependencies.
The final focused run passed **7 tests across 2 files**. An earlier run had a
fail-closed native process-census error (errno 1); no safety check was weakened.
Existing reclaim/restore focused checks passed 8 tests; the final affected
restore/reclaim rerun passed 4 tests. The root gate passed for `cb4da42f1` against
`279fb123`: exit 0, five compiler packages and **17 selected tests** across three
files. A prior root attempt caught a broad filesystem catch in restore fetch;
the final source tolerates only ENOENT. Landing remains pending for this second
change.
