# VUH-1473 — seat eval harness: built, seat arm unrun

Date: 2026-09-30. [Issue](https://linear.app/vuhlp/issue/VUH-1473).
[Run guide](../../evals.md#the-seat-suite). No push, deployment or live-service
restart was part of this work.

## Status

The seat suite is built: the throwaway sandboxed service, the fake Discord body and
herdr fleet, the real seat plugin launched from `clankie seat --dry-run`'s plan,
the driver for wakes and escalations, eleven cases with graders tested both ways,
and the startup-context measurement. **The real Claude seat arm has not been run
as a campaign.** Big evals were put on hold before its window came round, and this
harness landed without new trials.

During development, single seat-arm attempts on Claude Code 2.1.285 with Sonnet 5.5
passed `seat-wake` (a real service wake delivered to the seat, which checked the
fleet and reported VUH-1501 blocked) and `seat-baseline`, and an earlier spike
showed the plugin's hooks injecting persona and context and its MCP bridge
calling `observe_room` on the throwaway service. These are smoke checks, not
results.

## Partial Codex campaign (inconclusive)

A `bare` and `current` campaign on Codex CLI 0.159.1 with `gpt-6-astra`, commit
`4b13370a`, stopped at 106 of 110 calls when its process was ended; the last four
cells (`seat-where-things-live` and `seat-baseline`, repetition 4) never ran. It
recorded no errors. [Report](codex-bare-current-partial.json),
[summary](codex-bare-current-partial-summary.md).

It is preserved but **inconclusive**: there is no seat arm to compare against, it
ran on a different harness than the seat, and `current − bare` is within noise on
pass rate (+4 points, −29 to +36) and tokens. Per case it shows what a plain
agent on this machine can already do without Clankie's service:

- `bare` found the blocked worker through the fake `herdr` on `PATH` 5/5;
  `current` 2/5, because its instructions send it to `clankie`, which does not
  exist without the service. Neither answered the wake (0/5 each).
- `bare` hired through `herdr` directly 5/5; `current` 0/5, because its
  instructions route hiring through Clankie's tools, which do not exist without
  the service.
- `current` filed the Markdown work item 5/5 (the work-items skill); `bare` 0/5.
- Neither arm recalled the seeded decision, read a room, joined voice, posted to a
  room or answered the escalation (0/5 each): those need the service.

The report as run scored `current` 5/5 on the wake. Every one of those answers
said it could not verify whether VUH-1501 was still blocked, and the fleet grader
matched the worker and the word anyway. The grader now judges the claim in the
first sentence and rejects a hedge there, with tests for both the hedge and a real
report followed by a caveat. The archived report was regraded from each attempt's
saved observation; its `regraded` field lists the five changed rows.

## Findings from building it

These are code facts, verified against the service and bridge sources, not trial
results:

- No operator-lane tool posts to a Discord room. From the seat, the only way back
  to a room is answering an escalation with `reply`.
- Nothing escalates a Discord room to the seat. An `escalation` is any human send
  into the head conversation while a bridge is polling.
- Outside herdr, the seat's SessionStart prompt carries no fleet census; the
  seat learns about workers from its shell (`herdr`), not its context.
- `message_seat` reaches only seats Clankie hired himself, not other panes in the
  fleet.
- Headless `claude -p` receives no channel pushes: the bridge pumps only under an
  interactive development-channel launch that a person must confirm.
