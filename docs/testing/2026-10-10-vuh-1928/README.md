# VUH-1928: Claude hook notification failures

Verified on freshly fetched `origin/main`
`2c811fdb65a44b55c79c285a35de136317d7c38e`, in
`~/dev/clankie-wt/vuh-1928`, branch `fix/vuh-1928-question-notify`.

## Finding and change

The bug remained: `ClaudeHookQuestions.open()` discarded a rejected notification's
error and denied the tool with only `claude_hook_question_notify_failed`.
`HerdrWatchStore.forwardNativeQuestion()` requires exact persisted hiring
ownership; an operator or lead seat without it throws
`Native question has no exact hiring conversation`. The historical exception
cannot be recovered because the old catch swallowed it; that specific incident's
cause is not claimed as proven.

Missing hiring ownership now raises a distinct error. Only an `AskUserQuestion`
from that unowned route falls back to Claude's native prompt, with `allow`, no
updated input, no answers, and no delivery acknowledgment. All other notification
failures still deny, including every permission request. Owned seats retain their
exact-lead forwarding and occupant guards.

Both the hook reason and the service's stderr warning include the error and its
bounded cause chain, redacted before truncation. The warning identifies the pane
and request and whether native fallback occurred; it includes no question input.
The CLI guide and shipped Clankie skill describe these outcomes.

## Focused checks

```sh
clankie heavy -- pnpm exec vitest run \
  apps/clankie/test/claude-hook-command.integration.test.ts \
  apps/clankie/test/claude-hook-questions.integration.test.ts \
  apps/clankie/test/claude-permission-authority.integration.test.ts
```

**34 tests passed in 3 files, exit 0**, duration 2.35 seconds; started
2026-10-10 21:17:04 America/Chicago. Local output:
`.local/vuh-1928/focused-final.log`.

The installed `seat-hook.mjs` runs as a real subprocess against an authenticated
local HTTP hook endpoint. It exercises the production question registry, routing
and persisted ownership journal, with a native inventory fixture at the Herdr
boundary. Coverage proves:

- Owned forwarding returns the selected answer through the native command's
  stdout and acknowledgment; input, question IDs and options survive.
- Unowned operator questions return native `allow` without supplied answers or
  a false delivery acknowledgment; consumed requests cannot be replayed.
- Unowned and failed owned permission notification routes both deny.
- Other owned question failures deny with their redacted nested cause.
- A separate real service subprocess's stderr contains the same nested cause as
  its denial and excludes the injected bearer credential.
- Existing answer, persistence and permission-authority boundaries still pass.

## Limits and remaining live check

No live James answer or deployed Claude lead-chat prompt was performed. After
deployment, a lead-chat seat should call `AskUserQuestion`, show its native prompt
in its pane, and accept James's answer. The fallback intentionally does not claim
an app ask. No PC shell, PC Herdr, other-seat processes or live fleet journals
were changed. Landing gate and push evidence belong in the Linear issue after
the integrator completes.
