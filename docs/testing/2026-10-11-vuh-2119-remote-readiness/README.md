# Remote integration readiness and isolation

Tracks: https://linear.app/vuhlp/issue/VUH-2119/integrate-remoteintegrationtestts-flaked-on-the-macos-release-runner

The v0.4.4 candidate pre-flight [38125764001](https://github.com/Volpestyle/clankie/actions/runs/38125764001)
failed the report-timeout case at its unchanged 120-second test deadline, then
passed its isolated file rerun. JUnit and the first-attempt report identify the
case but do not record which earlier phase prevented readiness.

The fixture awaited its injected child's first output without observing terminal
queue state. If an earlier real stage, install or gate fell back locally, that
child could never start. The revised readiness wait races that signal against
queue completion and reports the actual batch cause. Progress assertions wait on
the published stalled state rather than sleeping 650 ms. Every assertion and
deadline remains unchanged.

## Reproduction

On main base `176724d07`, a diagnostic-only candidate first passed 10/10 locally.
A three-fork sampled three-core run with native process and CPU fixtures passed
28 active tests, then a repeat failed promptly: the real remote install produced
no output for 1,000 ms, regated locally, and never reached the injected child.
This proves a related setup contention failure; it does not establish the exact
preceding phase of the original report-mode CI hang.

Clankie approved moving this file into a serial Vitest project after the parallel
suite. Both projects reuse the same setup, exclusions, fork pool, zero retries,
30-second default deadlines and existing per-case overrides. No fake heartbeats,
product changes, budget increases or evals were introduced.

## Verification and cost

- Baseline and candidate select the same 913 files, with no duplicate or eval
  files. Only this file belongs to the later project.
- Grouped sampled three-core pass 1: 3 files, 28 passed / 1 skipped, 90.66 seconds.
  The serial phase started after both parallel files ended and took 77.60 seconds.
- Grouped pass 2 includes release recovery acceptance: 4 files, 33 passed /
  1 skipped, 87.92 seconds. Its serial phase took 69.33 seconds and began after
  all parallel files ended. The release reporter contains every selected file.
- An earlier isolated three-core pass completed 10/10 in 67.70 seconds.

The measured 69–78 second later phase is a conservative estimate of added wall
time when its previous parallel execution would have overlapped other tests.
It is not a complete runner-job measurement or a claimed speedup. Against the
lead's approximately 49-of-60-minute release estimate, allow about 1.3 extra
minutes; workflow allowances stay unchanged.

The manual governor reuses the repository's native CPU sampler inside an owned
`clankie heavy` group. It simulates three-core CPU bandwidth, not physical CPU
affinity. Native observation losses briefly resume execution, sampled charging
can double-count reaped children, and detached children escape the group. Raw
logs retain these limitations. The first harness launch failed before running
tests because the governor API had changed; it is retained separately.

Raw reports, logs and reproduction scripts are retained in this evidence bundle.
Fetch [reproduction.tar](clankie://evidence/sha256/d24c4758d9c70329b6804be995163c5b9962b9765e106da808d060f7da97e182)
and restore its files under `.local/vuh-2119/` in this checkout. Run the manual
sampler through `clankie heavy -- python3 .local/vuh-2119/constrained.py 3 pnpm exec
vitest run` with the named files above. Resolved configuration profiles also prove
CI and lower worker limits, docs-package selection, and exact remote/other-file
retry selection, with no eval files.
The explicit manual eval config clears inherited projects before selecting its
corpus. Discovery-only inspection confirmed that single-file selection; no eval
was executed.
The official main run [38131786566](https://github.com/Volpestyle/clankie/actions/runs/38131786566)
was dispatched on `176724d07` before this follow-up change, per the lead's priority;
it cannot prove the new serial configuration.

The first integration gate failed settings compilation: `UserConfig` is not
exported by `vitest/config`, and the selection callback lacked a parameter type.
The corrected config uses exported `ViteUserConfig` and an explicit string
parameter. The settings HOME-isolation fixture also clears inherited projects
before selecting its own private-store fixture; its focused proof passed 3/3.
The first requested root typecheck exposed a missing local relay-to-settings
workspace dependency link. Dependencies were refreshed through `clankie heavy`
after rebasing onto fetched main `c123cf488`; both failed and refreshed check
logs are retained under `.local/vuh-2119/`.
The refreshed repository-root `pnpm typecheck` completed exit 0: 31/31 tasks,
18 cached, 4m40.446s. The rebased settings isolation proof passed 3/3 in 4.14s;
scoped formatter, lint and diff checks passed. Integration's exact-tree gate
remains the landing authority.
Retained [type-correction.tar](clankie://evidence/sha256/4a78a57c4bf1c057ffc0b27c05ef14bdb462aac9555c5fe6d9978f649fa1593f)
contains the original failure, refreshed root pass and focused fixture results.
