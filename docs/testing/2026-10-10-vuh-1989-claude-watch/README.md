# Claude watcher channel gaps (VUH-1989)

Tracks: https://linear.app/vuhlp/issue/VUH-1989

The watcher no longer interprets a missing Claude mailbox poll as owner
takeover. Native work status and Stop observations remain available when
channel delivery is unavailable. A generic `released` event reports only
that programmatic control ended.

## Before and after

- Baseline: fetched `origin/main`, `98de6abb98f9f18a112fc0bd2a09fc341af0599c`.
  The regression failed against unchanged production code (exit 1): after the
  real worker mailbox's 15-second grace expired, `settled()` resolved while
  the native seat was still `working`, without pane input. See `before.log`.
- Candidate: the same real mailbox and persisted hook boundary keeps waiting.
  The expanded regression also arms the real `HerdrWatchStore`, checks no
  premature wake, and observes one wake containing the subsequent Stop report.
  Channel loss does not produce a takeover claim. All four focused files passed,
  108 tests, exit 0. See `after.log`.
- Final regression: 1 test passed after formatting and completing the native
  snapshot's required title, exit 0. See `regression-final.log`. The focused
  service typecheck also passed, exit 0 (`typecheck.log`). The earlier fixture
  type error is retained in `typecheck-before.log`.
- Existing delivery checks still assert that an unbound channel refuses a send.
  Native occupant/session checks and message-completion uncertainty remain intact.

Commands ran through `clankie heavy --`:

```sh
pnpm exec vitest run apps/clankie/test/claude-watch-takeover.integration.test.ts
pnpm exec vitest run apps/clankie/test/claude-watch-takeover.integration.test.ts apps/clankie/test/claude-worker-seat.test.ts apps/clankie/test/herdr-watch.test.ts apps/clankie/test/fleet-seat.test.ts
pnpm --filter @clankie/clankie typecheck
```

## Native evidence and scope

`native-subagent-footer.txt` retains the footer from a read-only
`herdr agent read w47:p1S` of the lead-designated Claude hire Basil. It shows
`← 6 agents` and background agent statuses. No input was sent to that seat.
This capture establishes the native UI shape, not a live reproduction of the
original Rue/Pippin incident; their original captures were unavailable.

The regression replays the background-subagent `UserPromptSubmit` event at the
production outbox/hook boundary. Claude's [hook contract](https://code.claude.com/docs/en/hooks#userpromptsubmit)
also emits that event for background subagent reports, scheduled tasks and
messages from other sessions, so the event alone does not prove owner input.
This is a deterministic boundary reproduction, not a newly launched Claude run.
The watcher now avoids claiming owner takeover without evidence; this change
does not add a new detector for physical owner input.

## Landing

This folder records the baseline reproduction and focused candidate checks.
The issue links the retained `clankie integrate --push` gate record and final
landed revision once integration completes.

## Released-event producer audit

Before submission, searched production seat-event producers and inspected all
seven remaining `type: "released"` returns (`released-producers.txt`): Pi (two),
OpenCode, Grok and Prime emit it for unavailable native control or a native settlement
failure; the fleet boundary (two) emits it when its connection authority ends.
None establishes owner input or relies on takeover wording. The existing
`packages/agent-hosts/src/seat.ts` contract defines `released` as programmatic
control ending, not proof of owner action. The generic notification now matches
that contract for every remaining producer. Claude no longer produces this event
from a mailbox poll gap.
