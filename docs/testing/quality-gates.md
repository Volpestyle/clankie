# Repeatable quality gates

`pnpm check` is the required local handoff and release gate. It includes the
HTTP journey, unit, integration, Rust, IPC, type, lint and documentation checks.
Pushes and pull requests run only fast formatting and lint on Linux. Run the
complete CI gate explicitly with `workflow_dispatch`; the release workflow also
runs it. There are no scheduled full checks. No paid model, Discord account,
live gateway or running operator service is required.

Evaluations are always explicit manual runs, including the frozen offline
calibration corpus. `pnpm check`, ordinary `pnpm test`, builds and releases do
not select that corpus. `pnpm test:eval` uses `vitest.eval.config.ts` to run it.
Authority and evaluator-runner unit regressions remain ordinary tests; they do
not execute evaluations.

| Lane                | Command                          | Evidence and limits                                                                                                            |
| ------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Full gate           | `pnpm check`                     | CI JUnit report in `.data/qa/tests.xml`; Rust/IPC results remain in the job log.                                               |
| Computer body       | `pnpm test:computer-integration` | Explicit real Chromium/localhost-fixture contract proof; excluded from default tests and checks. No comparison or model calls. |
| Host integration    | `pnpm test:integration`          | Loopback HTTP boot/restart, pairing, device authority, encryption and conversation relay.                                      |
| Manual offline eval | `pnpm test:eval`                 | Frozen play-evidence calibration cases. Every assertion must pass; this lane is excluded from full checks and releases.        |

The host-integration command selects tests already in the full gate. The eval
command is separate and never runs implicitly. Retries are disabled. CI cancels
superseded runs on the same ref, retains manual full-check reports for seven
days, and keeps its 30-minute ceiling. The private app's full client/host journey
and native builds run at release time or on an explicit manual run.

## Isolation and reproducibility

The shared `vitest.config.ts` setup gives each test file a fresh temporary HOME
and XDG directories before its imports. It overrides `CLANKIE_SETTINGS_FILE`
and `CLANKIE_CREDENTIALS_FILE`, selecting the file credential backend even on
macOS, and removes inherited Clankie, Discord, Herdr and provider-key overrides.
Node children inherit the same fixture paths. Cleanup removes the temporary
directory after the file finishes; tests supply their own synthetic overrides
when exercising configuration or authentication.

The isolation regression launches focused Vitest fixtures against populated,
empty and missing synthetic owner configs. A preload trap rejects filesystem
access to those paths and the original owner config paths, and rejects Keychain
commands, including in child processes. It also checks that fixture settings
and credentials can be read and written normally.

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
do not enable retries to hide the first failure. Native app evidence belongs in
the private app repository. Gateway production and account evidence belongs in
the private operations repository.
