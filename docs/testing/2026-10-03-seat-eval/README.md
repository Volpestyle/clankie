# VUH-1473 deterministic harness verification

Status: **BUILT, UNRUN, AWAITING JAMES RUN DECISION**. This records a deterministic
check of the existing harness on `b7c67ac9`; it is not a new seat/model campaign.

`pnpm exec vitest run --config vitest.config.ts apps/clankie/test/eval-runner.test.ts`
passed all 21 tests. They include all 11 seat cases (five capability-coverage
cases), acceptance/rejection of each grader, hedge rejection, reply observation,
arm planning and fake-Herdr behavior. No service, real fleet, model turn,
subscription probe or account action was launched for this check.

The [original seat evidence](../2026-09-30-seat-eval/README.md) remains authoritative
about its historical smoke checks and the 106/110 completed Codex bare/current
campaign. That partial campaign remains **inconclusive** and has no real seat arm.
The harness uses the real plugin against a throwaway service, but its headless
channel rendering is simulated; these unit tests do not establish native TUI
channel reliability or live post-retirement hiring. No preserved result was
changed or upgraded to a pass. A run, including a targeted one-repetition check,
requires James's decision; the full campaign remains deferred. The issue cannot
be marked Done on this evidence.
