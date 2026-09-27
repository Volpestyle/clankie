# Repeatable quality gates

`pnpm check` is the required main/PR and release gate. It includes the HTTP
journey and offline evaluation corpus below, alongside the existing unit,
integration, Rust, IPC, type, lint and documentation checks. No paid model,
Discord account, live gateway or running operator service is required.

| Lane             | Command                 | Evidence and limits                                                                                                          |
| ---------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Full gate        | `pnpm check`            | CI JUnit report in `.data/qa/tests.xml`; Rust/IPC results remain in the job log.                                             |
| Host integration | `pnpm test:integration` | Loopback HTTP boot/restart, pairing, device authority, encryption and conversation relay.                                    |
| Offline eval     | `pnpm test:eval`        | Frozen play-evidence calibration cases, Discord authority decisions and evaluator self-exclusion. Every assertion must pass. |

The focused commands select tests already in the full gate; CI does not run
those tests a second time. Retries are disabled. CI cancels superseded runs on
the same ref, retains test reports for seven days, and keeps its existing
30-minute ceiling. The private app runs its cross-repo client/host journey on
Linux; native device builds remain in its release/manual workflow.

## Isolation and reproducibility

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

## Failure handling

Reproduce the named failing suite first. To investigate flakiness, run the same
focused command several times with unchanged inputs and retain every result;
do not enable retries to hide the first failure. Native app evidence belongs in
the private app repository. Gateway production and account evidence belongs in
the private operations repository.
