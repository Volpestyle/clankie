# VUH-2335 Auto unused-capacity replay

Tracks: https://linear.app/vuhlp/issue/VUH-2335

Source base: `cb7f58b8ac708bafe4955010905c99957def9afb`; 2026-10-17 overnight build by Lark.

## Observed result

An isolated CLI replay of the issue's recorded 03:00Z facts returns `under_staffed`:

| Input                    | Recorded/replayed value                                                              |
| ------------------------ | ------------------------------------------------------------------------------------ |
| Working / occupied seats | 1 / 33                                                                               |
| Named ready work         | VUH-1803, VUH-2141, VUH-1968, VUH-2208                                               |
| Claude Max weekly usage  | 58% left, 3.9 days to reset; 13.55 percentage points/day burn, 1.32 points/day spare |
| Codex Pro weekly usage   | 80% left, 5.2 days to reset; 11.11 points/day burn, 4.27 points/day spare            |

Production staffing measurement → durable round journal → operator HTTP → `clankie auto rounds` retains the signal, ready keys, seat totals, plan observations and pace. Subsequent measurements record `unresolved` with unchanged staffing, `staffed` when working seats increase, and the respective `cap_reached`, `no_ready_work` and `plan_reserve` constraints. Empty ready work with headroom produces `backlog_not_ready` and the planning prompt.

This is a replay of the issue's reported aggregate, not a new live overnight observation. The historical raw census, per-project seat mapping/caps, account holds and short-window readings were not supplied. The explicit replay cohort groups the reported seats under one Auto scope, treats the 32 non-working seats as idle, leaves caps unset, and uses signed-in/unheld plans with the reported weekly windows. These are reconstructed inputs, not proof of historical hire authority. The separate integration fixture uses finite worker/WIP caps and a real built-in tracker to verify admission-related boundaries.

## Checks and boundaries

- `clankie heavy -- pnpm exec vitest run apps/clankie/test/auto-staffing.integration.test.ts apps/clankie/test/auto-velocity.integration.test.ts`: 16/16 tests passed at the focused check. Real built-in tracker → blocker graph → round journal → HTTP and CLI. A paginated connected-Linear contract fixture exercises owner blocking and an unrelated ready item. It is not a live Linear provider proof.
- The fixture verifies legacy HTTP responses omit additive staffing fields; the CLI opts in with `includeStaffing=true`.
- Bounded source/fixture typecheck passed; explicit touched-file lint passed. The root landing gate and any revalidation are reported on the issue with the final checked SHA/base and local receipt path.
- Stale, signed-out, held and expired-reset observations cannot become hiring headroom. A failed census yields null seat counts and no staffing claim. Worker cap zero and full WIP prevent an under-staffing signal. Ordinary role/model/machine/hire admission remains authoritative.
- The temporary proof server used loopback port 0 and a fixture bearer, then closed and deleted its temp state. No installed service, native lead, PC lane, real tracker, account or credentials were changed. No deploy, restart or release was performed.

The source change adds measurement and a prompt in the existing Auto wake, never automatic hiring, issue mutation, cap changes or extra owner notifications. The next installed/live Auto round is unobserved because deployment was outside this assignment.

Raw CLI output, replay inputs/script, source producer files and decisive check output are retained together in the evidence store (`evidence.json`).

## Landing-check repairs

The first completed root gate exited 1: the existing drift-proof fixture compared the newly opted-in CLI result with a legacy HTTP view, so their staffing fields differed. Its HTTP read now requests the same `includeStaffing=true` view; exact equality remains. The run also exposed an OpenCode fixture startup rejection before its later await. The fixture now observes that promise immediately while retaining the original rejecting promise for its existing await. No product assertion, timeout or retry was weakened. Both complete affected fixture files subsequently pass, 28/28; this is not a waiver of the root gate. The failed gate and focused repair checks are retained as separate evidence.
