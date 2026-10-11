# Fast Linux admission-fixture check — VUH-2126

Linux push/PR CI now runs a fixture-policy scan and nine focused checks. It
rejects missing pressure probes, ambient memory/load sources and subprocess
regressions before a release needs the full macOS suite. No production resource
limit or existing real-process assertion changed.

## Observed results

- Policy scan: 23 governor constructions across 23 test/driver files have
  explicit probes. The first run rejected the current disk-admission fixture's
  default pressure source; its unrelated memory/load inputs are now controlled
  while filesystem observations remain real.
- Seven policy contract cases run against temporary copies of the actual
  tests/drivers: valid fixtures pass; missing full-progress probes, a locally
  aliased factory, aliased `freemem`/`loadavg`, a standalone driver and an inline
  child's undefined probe all fail as expected.
- Two fast real-process cases use controlled low memory (2048 MiB against a
  4096 MiB floor) and load at exactly the thrash cap. Both retain one FIFO ticket,
  zero held permits and no started child.
- Final focused verification includes the longer real progress/starting/owned
  leftover cleanup and disk refusal/resume cases. Package typecheck and scoped
  lint pass. Formatting covers all touched files, including this report.

## Linux timing and method

The exact `check:fleet-test-pressure` script body passed three times inside an
owned, disposable Linux arm64 container capped at two CPUs and 4 GiB. Wall times:
2787, 2714 and 2772 ms. Each run passed 9 cases; the fast selector omits the two
longer full-progress cases. Queue admission, dependency installation and container
startup are excluded from the measured script cost.

Node 24.20.0, TypeScript 5.9.3 and Vitest 4.1.10; `CI=1` and the repository's real
Vitest configuration/setup were used. Source was copied from this worktree;
Linux dependencies came from the existing isolated build image
`clankie-vuh1823-build:arm64`. The container invoked the exact package script body
directly to avoid pnpm reinstalling its copied dependency links. CI invokes
`pnpm check:fleet-test-pressure` after its normal frozen install, on Node 26.7.0.
The local macOS command also passed on Node 26.7.0.

## Limits and retained failures

This is executed local Linux evidence, not a GitHub-runner timing claim. The fast
check proves explicit fixture preconditions and real Linux process admission; it
does not verify native Linux `MemAvailable`, Darwin memory observers or release
timing under load. The named native sampler/helper tests, Darwin pressure suite,
full progress/cleanup cases and manual release load checks remain available and
unchanged. The policy scan is a fixture convention, not an arbitrary JavaScript
dataflow or security analyzer.

The bundle retains the initial disk-fixture rejection, one intermediate guard
bug (an absent call argument), and the Linux setup attempt stopped by pnpm's
copied-dependency/catalog verification. These are failures, not passing samples.
The final logs and source hashes are retained with the evidence manifest.

Landing is pending the managed integration gate and push.
