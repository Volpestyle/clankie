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

The five-task `ab` set in
[`benchmark-tasks.json`](../../../scripts/evals/benchmark-tasks.json), both arms,
five repetitions: 50 scored trials through Harbor 0.23.0, three containers at a
time, 4.5 million reported tokens. [Report](terminal-bench.json),
[summary](terminal-bench-summary.md).

| Arm       | Pass rate   | 95% CI     | Tokens/trial (95% CI) | Agent time/trial |
| --------- | ----------- | ---------- | --------------------- | ---------------- |
| `bare`    | 22/25 (88%) | 70% to 96% | 64k (54k to 75k)      | 35 s             |
| `current` | 20/25 (80%) | 61% to 91% | 116k (96k to 138k)    | 38 s             |

Paired by task, `current − bare`: pass rate −8 points (−28 to 0), **within noise**.
Tokens +52k per trial (+30k to +78k), outside noise. Agent time is unchanged.

- Four tasks passed 5/5 in both arms, usually in 12–45 seconds of agent time.
  The set is near ceiling for Sonnet 5.5, so it can detect only a large
  regression.
- The whole difference is `configure-git-webserver`: `bare` 2/5, `current` 0/5.
  The task clones as `user@server` and its tests push as `user`, but runs in both
  arms set the repository up for a new `git` account instead. In every failure
  the test's push as `user` never reached the web root (HTTP 404). None of the
  `current` final answers mention Clankie or a skill. Five trials an arm cannot
  attribute this to the layer.
- Five early trials failed before the model ran: under amd64 emulation, three
  concurrent Claude Code installs pushed Harbor's agent setup past its 360-second
  limit (later setups took up to 521 seconds). The runner now allows three times
  the setup timeout, records such failures as infrastructure, requeues them, and
  excludes them from pass rates; the report keeps all five. The campaign was
  stopped and resumed in place with `--resume`; the three trials in flight at the
  stop were discarded unrecorded.

## Reading the baseline

On both suites the Clankie layer costs about twice the tokens of the bare harness
and shows no quality gain that five repetitions can distinguish from noise. The
Clankie suite shows one real gain (knowing where things live). Neither suite yet
has enough headroom to show the standing instructions or opinionated skills
helping on work the bare model gets wrong, so VUH-1456 and VUH-1457 need harder,
discriminating cases (a harder Terminal-Bench set, or cases the bare arm fails)
before a cut or keep can rest on a pass rate. The token cost is already measured.

## Throttling

The usage guard read each call's subscription windows. The five-hour window,
shared with the owner's other agents, reached the 80% threshold early in the run,
and both campaigns paused until its 07:50 reset. The weekly window stayed at or
below 19% through both campaigns. Reports keep every call's window readings.

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
