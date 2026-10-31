# Repeatable quality gates

`pnpm check` is the full manual and release gate. Per-change handoffs require the
root landing gate in ADR 0240. The full gate includes the
HTTP journey, unit, integration, Rust, IPC, type, lint and documentation checks.
Pushes and pull requests run fast formatting, lint and native MCP contracts on Linux.
Pull requests also run the landing gate's checks on Linux against their base;
exit 3, green checks waiting for the standing reviewer, passes there, and
macOS-only tests still need a Mac. Run the
complete CI gate explicitly with `workflow_dispatch`; the release workflow also
runs it. There are no scheduled full checks. No paid model, Discord account,
live gateway or running operator service is required.

The repository-root `pnpm check:landing` is required before a push. Focused
checks are for iteration; hand-picked subsets do not count as this gate. Rebase
onto fetched `origin/main` first. The command fixes `CLANKIE_LANDING_BASE`
(default: `origin/main`) to a SHA, runs static checks, then the compiler projects
affected through real imports (including type-only and relative cross-package
imports), with serial compiler execution. Compiler/dependency configuration
changes check all projects. Test selection unions Vitest's `--changed` import
graph with the per-test filesystem inputs in
`scripts/testing/landing-fs-inputs.mjs`. Declare paths there when a test reads a
manifest, fixture, native source or JS module through fs, a spawned build, or
a child-process import. In particular, worker bridge entrypoints and the local
modules their children import need declared edges even though they are `.mjs`. These edges
also enter each selected test's recorded dependencies, including the VUH-2044
manifest revalidation scope. A docs-only change adds no tests.
Changed non-JS executable inputs (native/script extensions, executable modes or
shebangs) without a declared consumer fail closed and are listed in the landing
report's `fsInputScope.unmappedExecutableInputs`. Inputs with no Vitest consumer
must instead have an explicit `landingNonVitestInputs` coverage declaration and
reason (for example, Vox cargo checks, manual Swift builds, or dated evidence
scripts). The report lists these reasons in `declaredExecutableInputs`; it does
not claim manual/release checks ran. Deletions retain base executable modes:
mapped deletions run their consumers, declared deletions retain their coverage
reason, and unknown deletions fail closed. This is an explicit coverage boundary; arbitrary data files still need declarations to select their consumers.
The compiler-input hash participates in Turbo's cache key, including imports
across package boundaries that are absent from package manifests.
Its static checks include `scripts/check-swallowed-rejections.mjs`: a line the
change adds may not drop a rejection silently (`.catch(() => undefined)`,
`.catch(() => {})`, `.catch(() => null)`) unless it or the line above carries
`// allow-swallowed-rejection -- REASON`. Tests, docs and evals are exempt, and
existing sites are not flagged until a change rewrites them; on 2026-10-17 there
were 604 outside tests, 398 of them in `apps/clankie/src` (VUH-2396).
The checked HEAD, base, source fingerprint, compiler scope, phase times and exit
are saved to `.local/landing-gate.json`; source changes during the run fail it.
Pass Vitest reporter options after `--`, for example `pnpm check:landing --
--reporter=json --outputFile=.local/landing-tests.json`.

If the root gate's only failures are unchanged timing-sensitive cases outside
the change and its affected imports, the lead may accept the landing after
every exact failing case passes in isolation on unchanged test/product inputs.
Retain the gate's real nonzero exit, exact errors, load samples and isolated
results, labelled **Full-gate result** and **Isolated passes**. This is a lead
acceptance decision, not a green full gate. Failures in changed code or affected
consumers still block; do not weaken assertions, timeouts or product defaults.

For repeated
reliability checks on unchanged main, keep a fixed baseline that selects the
regression and retain its individual result with `--reporter=json
--outputFile=PATH`. A clean comparison against `origin/main` may select zero
tests and still exit successfully; that is not regression evidence.

Evaluations are always explicit manual runs, including the frozen offline
calibration corpus. `pnpm check`, ordinary `pnpm test`, builds and releases do
not select that corpus. `pnpm test:eval` uses `vitest.eval.config.ts` to run it.
Authority and evaluator-runner unit regressions remain ordinary tests; they do
not execute evaluations.

| Lane                | Command                          | Evidence and limits                                                                                                                                                                                    |
| ------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Full gate           | `pnpm check`                     | CI JUnit report in `.data/qa/tests.xml`; Rust/IPC results remain in the job log.                                                                                                                       |
| Fleet load          | `pnpm check:load`                | Isolated real service, Herdr and ten simulated Codex worker bridges; CPU, health/tool latency, admission and Linear-call budgets. JSON evidence in `.data/qa/fleet-load.json`. Release or manual only. |
| Computer body       | `pnpm test:computer-integration` | Explicit real Chromium/localhost-fixture contract proof; excluded from default tests and checks. No comparison or model calls.                                                                         |
| Windows observation | `pnpm test:windows-observation`  | Explicit real Chromium/HTTP proof of Windows adapter translation and delegated authority; no PC input or claim of native Windows readiness. Excluded from default checks.                              |
| Host integration    | `pnpm test:integration`          | Loopback HTTP boot/restart, pairing, device authority, encryption and conversation relay.                                                                                                              |
| Manual offline eval | `pnpm test:eval`                 | Frozen play-evidence calibration cases. Every assertion must pass; this lane is excluded from full checks and releases.                                                                                |

For a local membership refusal in the load gate, inspect `proofDiagnostics` in
its JSON report. It retains native, transport, project and final proof reasons
with the pane, request and connection IDs, independently of the rolling service
log tail. Recoverable native diagnostics can also appear in a passing run;
correlate them with the final proof refusal and the gate's errors. Diagnostic
capture does not change admission or any gate budget.
The load service uses production's admission proof: a temporarily unavailable
observation returns a pre-dispatch retryable 503; a proven membership refusal
returns 403. The shipped worker bridge retains its one-retry contract for the
explicit unavailable response.

The host-integration command selects tests already in the full gate. The eval
command is separate and never runs implicitly. Vitest retries remain zero. Manual
macOS CI and tag releases use `node scripts/check-release.mjs`: it first runs the
full `pnpm check`, then reruns every failed Vitest file once, in a fresh one-worker
process, with file parallelism disabled. Every rerun must pass, including each
previously executed case. More than two recovered files blocks the release, and
the queue's `check:landing --retry-failed-tests` applies the same cap.
The job summary lists `Flaky on first attempt` with each file's failed cases; the original report and isolated
rerun reports remain in `.data/qa/`. Missing, incomplete, interrupted or unhandled-error
reports block recovery. A successful recovery also runs the original Vox tests
and IPC smoke check that the failed Vitest command prevented from running.
Non-test failures and ordinary push/PR CI have no retry. CI cancels
superseded runs on the same ref, retains manual full-check reports for seven
days, and allows 60 minutes for manual checks and 30 for ordinary CI. The macOS
tag-release job allows 65 minutes, including archive build and smoke; individual
test deadlines remain unchanged. The private app's full client/host journey
and native builds run at release time or on an explicit manual run.

On fleet machines, run full gates through `clankie heavy -- pnpm check`, one
gate at a time. Vitest defaults to four isolated forked processes locally and
three in CI, reducing contention from the test files' real service, SSH and
process fixtures on the three-core macOS runner. A two-fork full-suite estimate
would exceed the manual job's former 45-minute ceiling; see the
[release CI measurements](2026-10-11-release-ci-concurrency/README.md).
`VITEST_MAX_WORKERS` overrides the
default, including the lower limits supplied by `clankie heavy`.
Each file gets its own fixture HOME, temp directory and stores; the full suite selection
and manual eval boundary are the same as a single-file-at-a-time run.

`integrate-remote.integration.test.ts` runs in a later serial project, after the
parallel files finish. Its deliberately short remote silence and execution
deadlines exercise fallback and cleanup; competing process fixtures could expire
an earlier install before the intended failure phase began. The fixture waits
for actual readiness or terminal queue state, preserving every deadline. Package
selection and exact-file release retries still select the same files, and reports
include both projects. Local sampled three-core passes measured a 69–78 second
serial phase; this is potential added release wall time, not a runner measurement.
See [VUH-2119 evidence](2026-10-11-vuh-2119-remote-readiness/README.md).

The fleet load gate is separate from `pnpm check` and default tests. Version-tag
releases and explicit `workflow_dispatch` runs select it; ordinary pushes and
pull requests do not. It exercises fixture workers and a local Linear provider,
without model calls or owner credentials. See the retained JSON for workload,
source revision, budgets and measured outcomes.
The default ceilings are 9.9% captain-process CPU, 250 ms health p95, 2,000 ms
tool p95, zero admission refusals and 24 provider calls/minute. See the
[incident replay proof](2026-10-05-release-fleet-load/README.md) for calibration
and the distinction between an admission failure and measured regressions.

## Isolation and reproducibility

The shared `vitest.config.ts` setup gives each test file a fresh temporary HOME,
XDG directories and a private short `TMPDIR` (also `TMP` and `TEMP`) before its
imports. On Unix the temp root starts under `/tmp`, independently of the
caller's queue path, so nested fixture sockets fit the native Unix socket path
limit. It overrides `CLANKIE_SETTINGS_FILE`
and `CLANKIE_CREDENTIALS_FILE`, selecting the file credential backend even on
macOS, and removes inherited Clankie, Discord, Herdr and provider-key overrides.
Node children inherit the same fixture paths. Cleanup removes the temporary
directory after the file finishes; tests supply their own synthetic overrides
when exercising configuration or authentication.

The isolation regression launches focused Vitest fixtures against populated,
empty and missing synthetic owner configs. A preload trap rejects filesystem
access to those paths and the original owner config paths, and rejects Keychain
commands, including in child processes. It also checks that fixture settings
and credentials can be read and written normally, a real Unix socket can bind
under an overlong inherited temp directory, and child processes inherit the
private temp root. Both fixture roots are removed after the suite finishes.

Live store access is an explicit manual opt-in: `CLANKIE_TEST_LIVE_STORES=1`
disables the shared isolation. The existing Keychain smoke test separately
requires `CLANKIE_KEYCHAIN_TESTS=1`; injected fake Keychain runners remain ordinary
tests. Never enable either flag for an ordinary check or CI run.

`apps/clankie/test/fixtures/qa-service.ts` binds an OS-assigned loopback port,
uses a fixed injectable clock, a generated test-only signing key and bearer,
and a disposable event log. Restart reconstructs the production app from that
log. Cleanup closes its listener and removes its files. The captain is a stub:
this proves transport, authentication and persistence, not model reasoning.
The private app consumes this fixture from its sibling checkout to exercise its
production pairing client against the actual host routes. It records both Git
revisions in CI, so failures can be reproduced against the same pair.

## What the eval means

The checked-in synthetic corpus is
`packages/play/test/fixtures/free-play-corpus.json`. Labels are authored expected
outcomes, never regenerated from the evaluator. It includes successful movement,
claimed movement with no position change, missing legacy observations, matched
voice playback, unrelated receipts and suppression. Missing evidence must stay
unknown or unconfirmed. Add a named case when a real failure reveals a gap;
review expected-label changes as behavior changes.

This is deterministic evidence calibration and authority regression coverage.
It does **not** measure a live model's task success, tool choice, voice quality
or persona. Live comparisons remain explicit operator runs using the existing
comparison scripts and testing archives. Keep those out of automatic main/PR
jobs: they consume provider/agent budgets and external services. Record model,
revision, inputs, usage and artifacts when running them; never turn missing
live evidence into a green score.

## Current live-eval budget

James paused large live-model eval campaigns on 2026-09-30 after they exhausted
Claude usage. Continue delivery from completed evidence; do not automatically
resume a campaign when an account window resets. Full benchmarks and broad
multi-repetition campaigns remain on hold until James changes that direction.

If an actual change leaves a specific uncertainty, use only a few targeted cases,
starting with one repetition. Harvesting finished results needs no new trial.
Preserve completed trials and reports when stopping an identified producer, and
keep missing cells marked incomplete. Do not change graders to recover a pass.
Ordinary deterministic checks, including `pnpm check`, remain required.

## Failure handling

Reproduce the named failing suite first. To investigate flakiness, run the same
focused command several times with unchanged inputs and retain every result;
retain the first failure even when the release-only isolated rerun passes. The
bounded release retry is recorded on [VUH-2101](https://linear.app/vuhlp/issue/VUH-2101/macos-release-check-is-load-sensitive-on-3-core-runners);
continue fixing each load-sensitive fixture. Native app evidence belongs in
the private app repository. Gateway production and account evidence belongs in
the private operations repository.

For fixture requests whose callers wait at a native-operation barrier, observe
rejection when the request is created and retain the original promise for the
later assertion. Release the barrier and await the pending work in `finally`.
Connection loss during that gap must fail an assertion without producing an
unhandled rejection. A passing assertion and Vitest JSON `success: true` alone
are insufficient: retain the command exit status too, since unhandled errors
can make Vitest exit nonzero while its JSON still reports successful assertions.
