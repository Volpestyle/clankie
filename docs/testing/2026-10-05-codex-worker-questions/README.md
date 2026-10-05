# Codex worker questions and owner interruption — VUH-1688

The native-controller attachment now extracts the thread UUID from a Codex
rollout path. Previously it used the whole rollout basename, lost the hired
controller, and fell through to the native queue. This also explains the
reported unavailable question-answer channel.

Codex 0.160 async questions are `item/started` and `item/completed` notifications
containing an `agentMessage` with `delivery: "async"` and structured `questions`.
The item's ID is the function `call_id`; there is no async server request to
answer. Question IDs match the native TUI's JSON encoding of
`["request_user_input_async", call_id, index]`. Replies use
`<send_user_message_question_reply>` user-input envelopes, a fresh
`clientUserMessageId`, and ordinary `turn/steer` while active or `turn/start`
when idle. Confirmation requires the exact returned turn's user message,
client ID, and content. The original tool's `{accepted: true}` is no answer
receipt. Async replies have no atomic first-answer arbitration against an
owner reply; uncertain replies are latched against duplicate sends.

Sync questions retain their app-server response and winning tool-output check.
Blocking questions hold normal sends; async questions preserve native
nonblocking behavior. Both reach the exact persisted hiring conversation, and
the read-only roster projection shows “Waiting on a question” with its ID
without consuming a completion watch. Native approval prompts remain owner
decisions.

Matching `turn/completed` events with status `completed`, `interrupted`, or
`failed` release the active turn. An idle notification without a completion
event triggers a read-only `thread/read` reconciliation: the exact active turn
must be terminal, with no newer active turn. Pending sends wait for this proof;
stale or foreign completions cannot clear a newer turn. Interrupted/failed
turns retire stale questions, while unresolved async questions survive normal
completion and remain answerable.

The integration uses the real Clankie adapter, client, WebSocket transport,
hire ownership, roster projection, lead wake, and answer control. Only the
external app-server and Herdr view are fixture boundaries. It does not call a
model, sign in, touch a live pane, write Linear, or substitute terminal input.
Restored owned control avoids erroneous native-queue fallback; this is not a
claim that historical messages in an unmanaged native queue were drained.

## Protocol provenance

Installed `codex --version` reported `codex-cli 0.160.0`.
The installed `codex app-server generate-json-schema` output and these primary
tagged sources ground the fixture and reply framing:

- [Async tool handler](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/tools/handlers/request_user_input_async.rs)
- [Native async question identities](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/bottom_pane/async_questions/state.rs)
- [Native answered-question envelope](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/context-fragments/src/answered_question.rs)
- [Native app-server session dispatch](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/app_server_session.rs)
- [Persisted native user-message identity](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/thread_history.rs)

## Verification

All checks passed on the final source and protocol fixtures:

- Focused Vitest: **122/122**, ten files. The three new integration cases cover
  path-bound hire/lead/roster routing, active async answers and nonblocking
  follow-ups, interrupted-turn idle reconciliation, immediate release from an
  authenticated terminal event while an older read is held, late-read fencing,
  completed-before-subscription question hydration, idle reply turns, native
  UTF-8 framing, and missing-receipt/duplicate-answer refusal.
- `@clankie/clankie` and `@clankie/agent-hosts` typechecks: **passed**.
- Changed TypeScript lint, formatting, and `git diff --check`: **passed**.
- Documentation link, retired-claim, and public-guide checks: **passed**.

The focused test command was:

```sh
pnpm exec vitest run --config vitest.config.ts \
  apps/clankie/test/codex-app-server.test.ts \
  apps/clankie/test/codex-seat-adapter.test.ts \
  apps/clankie/test/codex-user-input.test.ts \
  apps/clankie/test/codex-hired-seat-protocol.integration.test.ts \
  apps/clankie/test/fleet-seat-boundary.test.ts \
  apps/clankie/test/fleet-seat-events.test.ts \
  apps/clankie/test/worker-lead-routing.test.ts \
  apps/clankie/test/seat-adapter-hire.test.ts \
  apps/clankie/test/codex-seat-driver.test.ts \
  apps/clankie/test/remote-codex-app-server.test.ts
```

Live owner/TUI verification remains a separate manual check. Historical
unmanaged native-queue drainage is unverified. No full `pnpm check`, eval,
sign-in, or live model call was run.

## Manual check

1. From the intended lead conversation, hire a Codex worker with a brief asking
   it to use `request_user_input_async` for a worktree choice. Keep that worker's
   native Herdr pane visible.
2. Verify the hiring conversation receives the question, exact `call_id`, and
   JSON-encoded question IDs, and its roster summary shows the pending request.
3. Reply with `message_seat` using only `questionAnswer`, the observed request ID,
   and all supplied question IDs. Confirm `status: answered` and a matching
   attributed user message in that same native thread. An active turn should
   be steered without an interrupt; an already completed question turn should
   start one reply turn.
4. Ask another async question and answer in the native pane. Verify a later
   lead reply to its resolved ID is refused. Do not resend an uncertain reply.
5. Start another worker turn, interrupt it with Esc in its pane, and send a
   follow-up from its lead. Confirm the idle seat accepts the follow-up once,
   with no `queued_until_turn_end` fallback. Complete it and send a second
   follow-up; confirm both return to the same lead.
6. Repeat with a blocking sync question. The lead reply should resolve the
   native request without interrupting it, and a normal follow-up should be
   held until the blocking prompt resolves. Permission prompts must still
   require the owner.

The fleet tool bridge returned HTTP 403 during this work. Issue evidence must
be relayed through the lead if it remains unavailable. At handoff, catalog
metadata recovered, but `linear_get_issue` still failed with a service timeout;
no issue comment was posted through an unverified connection.
