# VUH-1456 — standing instructions cut to identity, boundaries and where things live

Date: 2026-09-30. [Issue](https://linear.app/vuhlp/issue/VUH-1456).
[ADR 0203](../../adr/0203-clankie-keeps-what-better-models-cannot-absorb.md),
[run guide](../../evals.md), [baseline](../2026-09-30-eval-baseline/README.md).
No push, deployment or live-service restart was part of this work.

## What changed

`apps/clankie/src/captain/instructions.md` went from 14 sections to five: Identity,
Trust, Remembering, Where things live, Honesty. The text before the cut is frozen
as [`instructions-pre-1456.md`](../../../scripts/evals/instructions-pre-1456.md)
(eval arm `pre-1456`); the candidate that was tested is
[`trimmed.md`](../../../scripts/evals/trimmed.md), byte-identical to the new file.

| Old section                                                 | Where it went                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leading agents                                              | Generic judgment was already in the `lead` skill (delegation, one harvest owner, fixed done, tracker identity). Clankie tool usage is in the `hire_agent`, `message_seat`, `herdr_watch`, `work_items` and Swarm `connection` descriptions. Kept: trust in delegation, `hire_agent` over bare `herdr agent start`, `clankie herdr agent list`, pane naming, the ownership boundaries. |
| Connected work (Linear inbox protocol)                      | Already complete in the `this-machine` skill; the wake text now points there. Kept: tracker identity, mail and account boundaries, `mcp_tool_search`.                                                                                                                                                                                                                                 |
| Skills, Looking things up                                   | Computer-use delegation is on the reach card; skill-upkeep reminder dropped (no reflection ritual). Kept: `$skill-name` and disabled-skill rule, `clankie doctor` / `this-machine`.                                                                                                                                                                                                   |
| Initiative                                                  | Goal rules are in `create_goal`, `note_goal_decision`, `schedule_wake` and the goal-turn prompt. Kept: propose in conversation.                                                                                                                                                                                                                                                       |
| Remembering                                                 | Cut from ~480 to ~130 tokens; `retain`, `corrects` and status-receipt guidance were already in `remember_episode`.                                                                                                                                                                                                                                                                    |
| Your other rooms, songs, making things, diagrams, PokeAgent | Already in the tool descriptions; gaps added there (host recovery via `pokeagents`, voice handoffs in `observe_room`, narration in `get_self_state`, draw only what is true).                                                                                                                                                                                                         |
| Showing what you saw                                        | A new `# In Discord` paragraph in the `reach` section, Discord lanes only.                                                                                                                                                                                                                                                                                                            |
| Long code in files (VUH-1391)                               | The `# Machine access` paragraph, shell-holding lanes only.                                                                                                                                                                                                                                                                                                                           |

Hired workers never received the standing instructions: they get their brief, the
work-tracking contract and the selected skills. That is unchanged.

## Tokens per lane

Counted with `o200k_base` (Codex's tokenizer) on the real `assembleLanePrompt`
output, default persona, no fleet notes. Claude's tokenizer counts roughly 10%
more (the lead's 6.2k for the old file).

| Lane                                | Before | After |
| ----------------------------------- | -----: | ----: |
| `instructions.md` alone             |  5,584 | 1,194 |
| Operator (pi console), all sections |  5,870 | 1,519 |
| Discord text, social                |  5,915 | 1,608 |
| Discord text, machine grant         |  5,880 | 1,612 |
| Discord voice                       |  5,915 | 1,608 |
| Gameplay                            |  5,832 | 1,442 |
| Claude seat output style            |  6,045 | 1,655 |
| Codex seat instructions             |  5,795 | 1,405 |

Tool descriptions gained about 130 tokens net across five tools. Pi lanes send
them only where those tools exist; the Claude seat defers MCP tools, so they cost
nothing there until searched. The 35-skill catalog (~1.1k) is unchanged
(VUH-1457).

## Gate

**Codex was not run.** James asked for the gate on Codex. The eval's Codex account
(`~/.codex`, pro) reported its weekly window at 91% (resets 2026-10-04 21:00 CDT),
so the usage guard stopped the campaign after one call
([report](clankie-suite-codex-stopped.json)). The guard was not raised, and
`~/.codex-jamescvolpe` is not signed in.

**Claude, small, partial.** Following James's fallback, `current` against `trimmed`
on Claude Code 2.1.285 with `claude-sonnet-5-5`, planned as 16 cases × 2 reps.
The five-hour window, shared with live workers, reached the 80% guard after 20
calls; the run was stopped rather than resumed after the 12:50 reset, to leave
that window to the workers. It covers every incident case and five of the six
social cases once. `social-injection` and the held-out slice did not run.
[Report](clankie-suite-claude.json), [summary](clankie-suite-claude-summary.md).

| Arm       | Pass rate | Tokens/trial (95% CI) |
| --------- | --------- | --------------------- |
| `current` | 10/10     | 50k (41k to 58k)      |
| `trimmed` | 10/10     | 31k (23k to 40k)      |

Paired by case, tokens −19k per trial (−23k to −14k), outside noise. The
baseline's `bare` arm averaged 24k on the same suite, so the trimmed layer costs
about 7k per trial where the old one cost 27k. All five incident regressions and
`voice-interruption` passed in `trimmed` (it answered `clankie metrics`, the case
`bare` failed 0/5 in the baseline).

This is a weak gate. The suite is at ceiling for Sonnet 5.5, one repetition per
case cannot show a pass-rate difference, and the held-out slice is missing. It
shows that the cut does not break the known cases and that it cuts tokens; it
cannot show that nothing was lost. The seat and lead evals (VUH-1473, VUH-1474)
are the real gates.

## Validation

`pnpm exec vitest run` on the lane-prompt, both plugin, eval-runner, Linear
webhook, operator-context, herdr-seat and lane-MCP test files: 8 files, 96 tests.
`node integrations/{claude,codex}-plugin/build.mjs --check` pass. In `pnpm check`,
lint, typecheck and infra passed. Formatting failed only on another agent's
in-progress `scripts/evals/isolation.mjs` and `run.mjs`, and knip only on its
untracked `scripts/evals/seat*.mjs`.
