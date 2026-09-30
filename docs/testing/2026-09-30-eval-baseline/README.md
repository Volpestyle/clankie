# VUH-1467 — repeated bare-versus-current baseline

Date: 2026-09-30. [Issue](https://linear.app/vuhlp/issue/VUH-1467).
[Run guide](../../evals.md). No push, deployment or live-service restart was part
of this work.

Both arms used Claude Code 2.1.285 with `claude-sonnet-5-5` on the owner's Claude
Max subscription. `bare` is the harness alone; `current` adds the versioned Clankie
instructions and the 35 bundled skills. The baseline ran on Claude because Codex's
weekly window was already at 86–88% on the owner's plan; one Codex call verified
that path, and its usage guard stopped the run on the weekly window.

## Clankie suite

Sixteen cases (the five incident regressions, six other social scenarios, and the
five held-out cases), both arms, five repetitions each: 160 calls, no errors, no
unknown usage, 6.0 million reported tokens. [Report](clankie-suite.json),
[summary](clankie-suite-summary.md).

| Arm       | Pass rate    | 95% CI      | Tokens/trial (95% CI) | Wall/trial |
| --------- | ------------ | ----------- | --------------------- | ---------- |
| `bare`    | 75/80 (94%)  | 86% to 97%  | 24k (22k to 26k)      | 8 s        |
| `current` | 80/80 (100%) | 95% to 100% | 51k (47k to 55k)      | 8 s        |

Paired by case, `current − bare`: pass rate +6 points (0 to +19), **within noise**.
Tokens +27k per trial (+22k to +33k), outside noise: the Clankie layer roughly
doubles the cost of a small task. Wall time is unchanged.

- Every incident regression passed 25/25 in both arms, and so did the held-out
  slice. At this size the suite is at ceiling for Sonnet 5.5 and cannot show the
  standing instructions or skills helping on these failures. The failures were in
  the glue, as ADR 0203 says; a current model fixes the reduced reproduction with
  or without the layer.
- `incident-unaddressed-image` stayed silent 10/10. Framed neutrally, the model
  does not reply to an unaddressed image. The live incident came from the
  service's own turn text ("respond to what you actually see"), which VUH-1453
  removed, not from the model or the standing instructions.
- The one difference is `voice-interruption`: `bare` 0/5, `current` 5/5. Without
  the instructions the model does not know the `clankie metrics` command and
  declines to guess. That is where-things-live knowledge, which ADR 0203 keeps.

"Within noise" means not shown, not "no effect". To inform VUH-1456 and VUH-1457,
the suite needs cases the bare model fails.

## Terminal-Bench 2.1

In progress. The five-task `ab` set in
[`benchmark-tasks.json`](../../../scripts/evals/benchmark-tasks.json), both arms,
five repetitions (50 trials) through Harbor 0.23.0, three containers at a time.
Early trials show four of the five tasks solved in 12–45 seconds of agent time in
both arms, so this set is also near ceiling.

Five early trials failed before the model ran: under amd64 emulation, three
concurrent Claude Code installs pushed Harbor's agent setup past its 360-second
limit. The runner now allows three times the setup timeout, records such failures
as infrastructure, requeues them, and excludes them from pass rates. The campaign
was stopped and resumed in place with `--resume`; the three trials in flight at
the stop were discarded unrecorded.

## Throttling

The usage guard read each call's subscription windows. The five-hour window,
shared with the owner's other agents, reached the 80% threshold early in the run,
and both campaigns paused until its 07:50 reset. The weekly window stayed at or
below 15% through the Clankie suite. Reports keep every call's window readings.

## Validation

`pnpm exec vitest run apps/clankie/test/eval-runner.test.ts`: 12 tests, including
real macOS sandbox boundary tests, starters of every public code case failing
their checks, the bare arm's fixture, arm rotation, the usage gate, Codex rollout
parsing, statistics and Harbor result mapping. Every incident and held-out code
case was also checked against a reference fix (passes) and its starter (fails);
every social check against a correct and a wrong answer.

The full gate (`pnpm check`) passed formatting and lint and stopped at `knip` on
another agent's untracked `integrations/codex-plugin/hooks/run.mjs`; the remaining
steps run separately (`infra:check`, `typecheck`, `test`: 380 files, 3,235 tests)
passed.
